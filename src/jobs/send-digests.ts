// ─────────────────────────────────────────────────────────────
// DAILY DIGEST JOB — standalone script, run by Railway cron (NOT the web
// process). Once a day it:
//   1. pulls every pending notification (emailedAt IS NULL),
//   2. groups them by recipient,
//   3. best-effort resolves actor usernames + post titles,
//   4. sends ONE digest email per recipient (respecting emailDigest),
//   5. stamps emailedAt so nothing is ever re-sent.
//
// Run locally:  bun run jobs:digest
// Railway:      add a Cron service with the start command `bun run jobs:digest`
//               and a schedule like `0 9 * * *` (09:00 UTC).
//
// Forward-only by construction: it only reads rows recordNotification()
// created, so pre-existing comments/votes are never back-emailed.
// ─────────────────────────────────────────────────────────────

import { prisma } from "../utils/db";
import { sendEmail } from "../utils/email";
import { digestEmail, type DigestItem } from "../emails/templates";
import { unsubscribeUrl } from "../utils/email-token";
import { appUrl } from "../utils/env";
import type { NotificationType } from "../generated/prisma/client";

// NOTE: we deliberately pass ALL events per section to the template (no
// pre-slicing). The template groups them by post and shows a COUNT for busy
// posts ("…got 5 upvotes"), so trimming here would corrupt those counts.
// The template caps the number of post-LINES and collapses overflow into
// "…and N more".

const TITLE_MAX = 60;
const SNIPPET_MAX = 80;
function truncate(s: string, max = TITLE_MAX): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

async function run(): Promise<void> {
  const startedAt = new Date();
  console.log(`[digest] run started ${startedAt.toISOString()}`);

  // Snapshot the pending set up front. We stamp emailedAt by id at the end,
  // so notifications created mid-run stay pending for tomorrow.
  const pending = await prisma.notification.findMany({
    where: { emailedAt: null },
    select: {
      id: true,
      userId: true,
      type: true,
      actorId: true,
      postId: true,
      commentId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  if (pending.length === 0) {
    console.log("[digest] nothing pending — done");
    return;
  }

  // Group by recipient.
  const byUser = new Map<string, typeof pending>();
  for (const n of pending) {
    const arr = byUser.get(n.userId) ?? [];
    arr.push(n);
    byUser.set(n.userId, arr);
  }

  // Batch-resolve the lookups so we don't N+1 across users. We need each
  // post's title + rating (rating ⇒ it's a "review", else a "post"), each
  // involved comment's body (for the one-line snippet), and the actor's
  // username — comment/reply BODY lines read "X commented: …" (the recipient-
  // centric headline lives in the subject + on aggregated lines).
  const postIds = [...new Set(pending.map((n) => n.postId).filter(Boolean))] as string[];
  const commentIds = [...new Set(pending.map((n) => n.commentId).filter(Boolean))] as string[];
  const actorIds = [...new Set(pending.map((n) => n.actorId).filter(Boolean))] as string[];

  const [recipients, posts, comments, actors] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: [...byUser.keys()] } },
      select: { id: true, email: true, username: true, emailDigest: true },
    }),
    prisma.post.findMany({
      where: { id: { in: postIds } },
      select: { id: true, title: true, rating: true },
    }),
    prisma.comment.findMany({
      where: { id: { in: commentIds } },
      select: { id: true, body: true },
    }),
    prisma.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, username: true },
    }),
  ]);

  const recipientById = new Map(recipients.map((u) => [u.id, u]));
  const post = new Map(posts.map((p) => [p.id, p]));
  const commentBody = new Map(comments.map((cm) => [cm.id, cm.body]));
  const actorName = new Map(actors.map((u) => [u.id, u.username]));

  // Every line links to the post page (comments live there too) — "the right
  // place" regardless of whether the event was a comment or an upvote.
  const APP = appUrl();
  const hrefFor = (postId: string | null) => (postId ? `${APP}/posts/${postId}` : APP);

  let sent = 0;
  let skipped = 0;

  for (const [userId, notes] of byUser) {
    const ids = notes.map((n) => n.id);
    const user = recipientById.get(userId);

    // User vanished, or opted out: drop their pending rows (stamp them) so
    // the table doesn't grow forever, but send nothing.
    if (!user || !user.emailDigest) {
      await markEmailed(ids);
      skipped++;
      continue;
    }

    const itemsOf = (type: NotificationType): DigestItem[] =>
      notes
        .filter((n) => n.type === type)
        .map((n) => {
          const isCommentTarget = type === "COMMENT_UPVOTE" || type === "REPLY";
          const p = n.postId ? post.get(n.postId) : undefined;
          // Snippet only where a comment's text is meaningful: the new
          // comment (COMMENT_ON_POST), the reply (REPLY), or the upvoted
          // comment (COMMENT_UPVOTE). POST_UPVOTE has no comment.
          const snippet =
            type !== "POST_UPVOTE" && n.commentId && commentBody.has(n.commentId)
              ? truncate(commentBody.get(n.commentId)!, SNIPPET_MAX)
              : undefined;
          return {
            targetType: isCommentTarget ? "comment" : p?.rating != null ? "review" : "post",
            targetName: truncate(p?.title ?? "a post"),
            href: hrefFor(n.postId),
            snippet,
            actor: (n.actorId && actorName.get(n.actorId)) || "Someone",
            // Upvotes-on-comments group per comment; everything else per post.
            groupKey: type === "COMMENT_UPVOTE" ? (n.commentId ?? n.id) : (n.postId ?? n.id),
          };
        });

    const email = digestEmail({
      username: user.username,
      commentsOnPosts: itemsOf("COMMENT_ON_POST"),
      replies: itemsOf("REPLY"),
      upvotes: itemsOf("POST_UPVOTE"),
      commentUpvotes: itemsOf("COMMENT_UPVOTE"),
      appUrl: APP,
      unsubscribeUrl: unsubscribeUrl(userId),
    });

    const result = await sendEmail({ to: user.email, ...email });

    // Only stamp as emailed when the send actually succeeded. A failed
    // send (provider down) leaves the rows pending so tomorrow's run
    // retries — at worst the user gets a slightly larger digest later.
    if (result.ok) {
      await markEmailed(ids);
      sent++;
    } else {
      console.warn(`[digest] send failed for ${userId} — leaving ${ids.length} rows pending`);
    }
  }

  console.log(
    `[digest] done — ${sent} sent, ${skipped} skipped (opted-out/missing), ${pending.length} rows processed`,
  );
}

async function markEmailed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.notification.updateMany({
    where: { id: { in: ids } },
    data: { emailedAt: new Date() },
  });
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[digest] fatal:", err);
    process.exit(1);
  });
