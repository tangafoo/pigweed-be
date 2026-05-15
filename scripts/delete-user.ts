import { prisma } from "../src/utils/db";
import { isProdDatabase } from "../src/utils/env";

// Interactive admin script — HARD-deletes a user. Cascades fire and take
// down all their content, plus any other-user content that hangs off it
// (comments on their posts, replies to their comments, votes/awards on
// any of it). This is the aggressive option; we chose it over anonymize
// because anonymize leaves the original vote in place while freeing the
// email for re-registration, opening a vote-inflation vector
// (vote → delete acc → re-register → vote again = 2 counted votes from
// the same person).
//
// One pre-step we do manually: decrement upvoteCount / downvoteCount on
// every post and comment this user voted on. Cascades remove the vote
// rows but the cached counts on the targets do not auto-adjust.
//
// Run: bun delete:user

function ask(question: string): string {
  const answer = prompt(question);
  if (answer === null) {
    console.log("\nAborted.");
    process.exit(1);
  }
  return answer.trim();
}

async function main() {
  console.log("\n=== pigweed user delete (HARD) ===\n");

  const claimed = ask("Environment? (dev/prod):").toLowerCase();
  if (claimed !== "dev" && claimed !== "prod") {
    console.log('Invalid — must be "dev" or "prod". Aborted.');
    process.exit(1);
  }
  const actuallyProd = isProdDatabase();
  if (claimed === "dev" && actuallyProd) {
    console.error('Mismatch: you said "dev" but DATABASE_URL/DIRECT_URL points at prod. Aborted.');
    process.exit(1);
  }
  if (actuallyProd) {
    const ack = ask('Confirmed prod. Type "I UNDERSTAND" to continue: ');
    if (ack !== "I UNDERSTAND") {
      console.log("Aborted.");
      process.exit(1);
    }
  }

  const lookupBy = ask("Lookup by? (email):").toLowerCase();
  if (lookupBy !== "email") {
    console.log('Only "email" is supported. Aborted.');
    process.exit(1);
  }

  const email = ask("Email:");
  if (email.length === 0) {
    console.log("No email entered. Aborted.");
    process.exit(1);
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      createdAt: true,
      coinBalance: true,
      unlockCoins: true,
      _count: {
        select: {
          posts: true,
          comments: true,
          postAwardsGiven: true,
          commentAwardsGiven: true,
          postVotes: true,
          commentVotes: true,
        },
      },
    },
  });

  if (!user) {
    console.log(`\nNo user with email "${email}". Aborted.`);
    process.exit(1);
  }

  console.log("\nFound:");
  console.log(`  id              ${user.id}`);
  console.log(`  name            ${user.name}`);
  console.log(`  email           ${user.email}`);
  console.log(`  joined          ${user.createdAt.toISOString()}`);
  console.log(`  coinBalance     ${user.coinBalance}`);
  console.log(`  unlockCoins     ${user.unlockCoins}`);
  console.log(`  posts           ${user._count.posts}`);
  console.log(`  comments        ${user._count.comments}`);
  console.log(`  awards granted  ${user._count.postAwardsGiven + user._count.commentAwardsGiven}`);
  console.log(`  votes cast      ${user._count.postVotes + user._count.commentVotes}`);

  console.log("\nThis HARD-DELETES the user, cascading to:");
  console.log("  • their posts (and every comment/vote/award on those posts, from anyone)");
  console.log("  • their comments (and every reply/vote/award on those comments, from anyone)");
  console.log("  • their own votes, awards given, unlocks, achievements, sessions, accounts");
  console.log("\nCached upvote/downvote counts on targets they voted on will be decremented first.");
  const confirm = ask('\nType "CONFIRM" to proceed: ');
  if (confirm !== "CONFIRM") {
    console.log("Aborted.");
    process.exit(1);
  }

  console.log("\nDeleting...");

  // Step 1: gather every (target, vote-direction) pair so we know how
  // much to decrement on each post and comment. Reading the rows once
  // ahead of time is cheaper than computing per-target decrements with
  // GROUP BY in SQL when the user's vote count is small.
  const [postVotes, commentVotes] = await Promise.all([
    prisma.postVote.findMany({
      where: { userId: user.id },
      select: { postId: true, value: true },
    }),
    prisma.commentVote.findMany({
      where: { userId: user.id },
      select: { commentId: true, value: true },
    }),
  ]);

  // Aggregate so we issue at most one UPDATE per target, not one per vote.
  const postDeltas = new Map<string, { up: number; down: number }>();
  for (const v of postVotes) {
    const cur = postDeltas.get(v.postId) ?? { up: 0, down: 0 };
    if (v.value === "UP") cur.up++;
    else cur.down++;
    postDeltas.set(v.postId, cur);
  }
  const commentDeltas = new Map<string, { up: number; down: number }>();
  for (const v of commentVotes) {
    const cur = commentDeltas.get(v.commentId) ?? { up: 0, down: 0 };
    if (v.value === "UP") cur.up++;
    else cur.down++;
    commentDeltas.set(v.commentId, cur);
  }

  // One transaction: all count adjustments + the user delete. If anything
  // fails, the whole thing rolls back and the user is untouched.
  const postUpdates = Array.from(postDeltas.entries()).map(([postId, d]) =>
    prisma.post.update({
      where: { id: postId },
      data: {
        upvoteCount: { decrement: d.up },
        downvoteCount: { decrement: d.down },
      },
    }),
  );
  const commentUpdates = Array.from(commentDeltas.entries()).map(([commentId, d]) =>
    prisma.comment.update({
      where: { id: commentId },
      data: {
        upvoteCount: { decrement: d.up },
        downvoteCount: { decrement: d.down },
      },
    }),
  );

  await prisma.$transaction([
    ...postUpdates,
    ...commentUpdates,
    prisma.user.delete({ where: { id: user.id } }),
  ]);

  console.log("\n✓ Delete successful\n");
  console.log(`  user                  hard-deleted`);
  console.log(`  posts cascaded        ${user._count.posts}  (with their comments / votes / awards)`);
  console.log(`  comments cascaded     ${user._count.comments}  (with their replies / votes / awards)`);
  console.log(`  vote counts adjusted  ${postDeltas.size + commentDeltas.size} targets`);
  console.log(`  email freed           ${user.email} (now available for re-registration)\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nError:", err);
    process.exit(1);
  });
