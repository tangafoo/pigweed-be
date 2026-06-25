import { Hono } from "hono";
import { prisma } from "../utils/db";
import { VoteValue } from "../generated/prisma/client";
import { recordNotification } from "../utils/notifications";
import { requireSignIn, type AuthVars } from "../middleware/require-sign-in";

export const votes = new Hono<AuthVars>();

// Request body accepts the same enum strings the DB stores: "UP" or "DOWN".
// Returns null on anything else so the route can 400.
function parseValue(input: unknown): VoteValue | null {
  return input === "UP" || input === "DOWN" ? input : null;
}

// Given the previous vote (or none) and the new vote, return the deltas to
// apply to the target's upvoteCount and downvoteCount. Returns null when the
// vote is unchanged (idempotent PUT — no DB write needed).
function countDeltas(
  prev: VoteValue | null,
  next: VoteValue,
): { up: number; down: number } | null {
  if (prev === next) return null;
  if (prev === null) return { up: next === "UP" ? 1 : 0, down: next === "DOWN" ? 1 : 0 };
  // prev is the opposite of next: shift one count down, the other up
  return { up: next === "UP" ? 1 : -1, down: next === "DOWN" ? 1 : -1 };
}

// ─────────────────────────────────────────────────────────────
// POST VOTES
// ─────────────────────────────────────────────────────────────

votes.put("/posts/:postId/vote", requireSignIn, async (c) => {
  const userId = c.get("userId");
  const postId = c.req.param("postId");
  const body = await c.req.json().catch(() => null);

  const value = parseValue(body?.value);
  if (value === null) return c.json({ error: 'value must be "UP" or "DOWN"' }, 400);

  const post = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true, authorId: true },
  });
  if (!post) return c.json({ error: "post not found" }, 404);

  const existing = await prisma.postVote.findUnique({
    where: { userId_postId: { userId, postId } },
    select: { value: true },
  });

  const deltas = countDeltas(existing?.value ?? null, value);
  if (deltas === null) {
    // Idempotent — same vote as before, return current state
    const fresh = await prisma.post.findUnique({
      where: { id: postId },
      select: { upvoteCount: true, downvoteCount: true },
    });
    return c.json({ ...fresh, myVote: value });
  }

  // Vote write + count bump in one transaction so a crash mid-flight can't
  // leave the count out of sync with the votes table.
  const [, updated] = await prisma.$transaction([
    prisma.postVote.upsert({
      where: { userId_postId: { userId, postId } },
      create: { userId, postId, value },
      update: { value },
    }),
    prisma.post.update({
      where: { id: postId },
      data: {
        upvoteCount: { increment: deltas.up },
        downvoteCount: { increment: deltas.down },
      },
      select: { upvoteCount: true, downvoteCount: true },
    }),
  ]);

  console.log(`[votes] post ${postId} ${value} by ${userId} → net ${updated.upvoteCount - updated.downvoteCount}`);

  // Digest notification only on a *fresh* upvote — i.e. the vote just
  // became UP and wasn't UP before (covers null→UP and DOWN→UP, skips
  // re-affirming an existing UP, which countDeltas already short-circuits
  // above). Downvotes never notify; we don't email people negativity.
  if (value === "UP" && existing?.value !== "UP") {
    recordNotification({
      recipientId: post.authorId,
      actorId: userId,
      type: "POST_UPVOTE",
      postId,
    });
  }

  return c.json({ ...updated, myVote: value });
});

votes.delete("/posts/:postId/vote", requireSignIn, async (c) => {
  const userId = c.get("userId");
  const postId = c.req.param("postId");

  const existing = await prisma.postVote.findUnique({
    where: { userId_postId: { userId, postId } },
    select: { value: true },
  });
  if (!existing) {
    // No vote to remove — return current counts, idempotent
    const fresh = await prisma.post.findUnique({
      where: { id: postId },
      select: { upvoteCount: true, downvoteCount: true },
    });
    if (!fresh) return c.json({ error: "post not found" }, 404);
    return c.json({ ...fresh, myVote: null });
  }

  const [, updated] = await prisma.$transaction([
    prisma.postVote.delete({
      where: { userId_postId: { userId, postId } },
    }),
    prisma.post.update({
      where: { id: postId },
      data: {
        upvoteCount: { increment: existing.value === "UP" ? -1 : 0 },
        downvoteCount: { increment: existing.value === "DOWN" ? -1 : 0 },
      },
      select: { upvoteCount: true, downvoteCount: true },
    }),
  ]);

  console.log(`[votes] post ${postId} vote cleared by ${userId} → net ${updated.upvoteCount - updated.downvoteCount}`);

  return c.json({ ...updated, myVote: null });
});

// ─────────────────────────────────────────────────────────────
// COMMENT VOTES — same shape as post votes, different table
// ─────────────────────────────────────────────────────────────

votes.put("/comments/:commentId/vote", requireSignIn, async (c) => {
  const userId = c.get("userId");
  const commentId = c.req.param("commentId");
  const body = await c.req.json().catch(() => null);

  const value = parseValue(body?.value);
  if (value === null) return c.json({ error: 'value must be "UP" or "DOWN"' }, 400);

  const comment = await prisma.comment.findFirst({
    where: { id: commentId, deletedAt: null },
    select: { id: true, authorId: true, postId: true },
  });
  if (!comment) return c.json({ error: "comment not found" }, 404);

  const existing = await prisma.commentVote.findUnique({
    where: { userId_commentId: { userId, commentId } },
    select: { value: true },
  });

  const deltas = countDeltas(existing?.value ?? null, value);
  if (deltas === null) {
    const fresh = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { upvoteCount: true, downvoteCount: true },
    });
    return c.json({ ...fresh, myVote: value });
  }

  const [, updated] = await prisma.$transaction([
    prisma.commentVote.upsert({
      where: { userId_commentId: { userId, commentId } },
      create: { userId, commentId, value },
      update: { value },
    }),
    prisma.comment.update({
      where: { id: commentId },
      data: {
        upvoteCount: { increment: deltas.up },
        downvoteCount: { increment: deltas.down },
      },
      select: { upvoteCount: true, downvoteCount: true },
    }),
  ]);

  console.log(`[votes] comment ${commentId} ${value} by ${userId} → net ${updated.upvoteCount - updated.downvoteCount}`);

  // Mirror of post upvotes: notify the comment's author only on a fresh
  // UP (null→UP / DOWN→UP), never on downvotes. postId rides along so the
  // digest can show which post the comment was on.
  if (value === "UP" && existing?.value !== "UP") {
    recordNotification({
      recipientId: comment.authorId,
      actorId: userId,
      type: "COMMENT_UPVOTE",
      postId: comment.postId,
      commentId,
    });
  }

  return c.json({ ...updated, myVote: value });
});

votes.delete("/comments/:commentId/vote", requireSignIn, async (c) => {
  const userId = c.get("userId");
  const commentId = c.req.param("commentId");

  const existing = await prisma.commentVote.findUnique({
    where: { userId_commentId: { userId, commentId } },
    select: { value: true },
  });
  if (!existing) {
    const fresh = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { upvoteCount: true, downvoteCount: true },
    });
    if (!fresh) return c.json({ error: "comment not found" }, 404);
    return c.json({ ...fresh, myVote: null });
  }

  const [, updated] = await prisma.$transaction([
    prisma.commentVote.delete({
      where: { userId_commentId: { userId, commentId } },
    }),
    prisma.comment.update({
      where: { id: commentId },
      data: {
        upvoteCount: { increment: existing.value === "UP" ? -1 : 0 },
        downvoteCount: { increment: existing.value === "DOWN" ? -1 : 0 },
      },
      select: { upvoteCount: true, downvoteCount: true },
    }),
  ]);

  console.log(`[votes] comment ${commentId} vote cleared by ${userId} → net ${updated.upvoteCount - updated.downvoteCount}`);

  return c.json({ ...updated, myVote: null });
});
