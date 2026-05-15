import { Hono } from "hono";
import { prisma } from "../utils/db";
import { VoteValue } from "../generated/prisma/client";
import { makeId, ID_PREFIX } from "../utils/ids";
import { bus } from "../events/bus";
import { moderate } from "../utils/ai/moderator";
import { requireSignIn, type AuthVars } from "../middleware/require-sign-in";
import { optionalSignIn, type ViewerVars } from "../middleware/optional-sign-in";

export const comments = new Hono<AuthVars & ViewerVars>();

const BODY_MAX = 5000;

// A comment is flagged hidden=true when its net score (upvotes minus
// downvotes) drops below this value. Forgiving — a popular-but-spicy
// comment with 100 ups and 10 downs (net +90) stays visible; only
// genuinely-downvoted content is collapsed. Body still ships so the
// frontend can offer a click-to-reveal UX.
const HIDE_BELOW_SCORE = -5;

// Single source of truth for the comment shape returned by every endpoint.
// `deletedAt` and `postId` are included so the redactor and downstream
// queries can use them. Author is trimmed to non-sensitive fields.
const commentSelect = {
  id: true,
  postId: true,
  parentCommentId: true,
  depth: true,
  body: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  upvoteCount: true,
  downvoteCount: true,
  moderated: true,
  author: { select: { id: true, name: true, image: true } },
} as const;

// Reddit-style redaction: deleted rows stay in the list (tree integrity)
// but body and author identity are scrubbed.
function redactIfDeleted<T extends { deletedAt: Date | null; body: string; author: unknown }>(row: T) {
  if (!row.deletedAt) return row;
  return { ...row, body: "[deleted]", author: null };
}

// Build a commentId → vote-value map for the current viewer over the given
// set of comments. Returns an empty map when the viewer is anonymous or the
// id list is empty (no DB call in those cases).
async function viewerVotes(
  viewerId: string | undefined,
  commentIds: string[],
): Promise<Map<string, VoteValue>> {
  if (!viewerId || commentIds.length === 0) return new Map();
  const votes = await prisma.commentVote.findMany({
    where: { userId: viewerId, commentId: { in: commentIds } },
    select: { commentId: true, value: true },
  });
  return new Map(votes.map((v) => [v.commentId, v.value]));
}

type AwardSummaryRow = {
  awardTypeId: string;
  assetKey: string;
  name: string;
  count: number;
};

// Build a commentId → AwardSummaryRow[] map. Anonymous aggregation — granters
// live behind /comments/:id/awards/granters. Sorted by count desc.
async function awardSummaries(commentIds: string[]): Promise<Map<string, AwardSummaryRow[]>> {
  if (commentIds.length === 0) return new Map();

  const rows = await prisma.commentAward.findMany({
    where: { commentId: { in: commentIds } },
    select: {
      commentId: true,
      awardTypeId: true,
      awardType: { select: { assetKey: true, name: true } },
    },
  });

  const byComment = new Map<string, Map<string, AwardSummaryRow>>();
  for (const r of rows) {
    let inner = byComment.get(r.commentId);
    if (!inner) {
      inner = new Map();
      byComment.set(r.commentId, inner);
    }
    const existing = inner.get(r.awardTypeId);
    if (existing) {
      existing.count++;
    } else {
      inner.set(r.awardTypeId, {
        awardTypeId: r.awardTypeId,
        assetKey: r.awardType.assetKey,
        name: r.awardType.name,
        count: 1,
      });
    }
  }

  const out = new Map<string, AwardSummaryRow[]>();
  for (const [commentId, inner] of byComment) {
    const arr = Array.from(inner.values());
    arr.sort((a, b) => b.count - a.count);
    out.set(commentId, arr);
  }
  return out;
}

// POST /posts/:postId/comments — create top-level OR reply.
// No depth cap; the FE decides what to render and where to surface
// "Read more comments".
comments.post("/posts/:postId/comments", requireSignIn, async (c) => {
  const userId = c.get("userId");
  const postId = c.req.param("postId");
  const body = await c.req.json().catch(() => null);

  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (text.length === 0 || text.length > BODY_MAX) {
    return c.json({ error: `body must be 1-${BODY_MAX} chars` }, 400);
  }

  const parentCommentId =
    typeof body?.parentCommentId === "string" && body.parentCommentId.length > 0
      ? body.parentCommentId
      : null;

  const post = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true },
  });
  if (!post) return c.json({ error: "post not found" }, 404);

  let depth = 0;
  if (parentCommentId) {
    const parent = await prisma.comment.findFirst({
      where: { id: parentCommentId, deletedAt: null },
      select: { id: true, postId: true, depth: true },
    });
    if (!parent) return c.json({ error: "parent comment not found" }, 404);
    if (parent.postId !== postId) {
      return c.json({ error: "parent comment belongs to a different post" }, 400);
    }
    depth = parent.depth + 1;
  }

  const mod = await moderate(text);
  if (!mod.allowed) {
    return c.json(
      { error: `flagged for ${mod.reason}`, code: "CONTENT_FLAGGED", categories: mod.categories },
      422,
    );
  }

  const comment = await prisma.comment.create({
    data: { id: makeId(ID_PREFIX.COMMENT), postId, authorId: userId, parentCommentId, depth, body: text, moderated: mod.moderated },
    select: commentSelect,
  });

  bus.emit({ type: "comment_created", userId });

  return c.json({ comment }, 201);
});

// GET /posts/:postId/comments — returns ALL comments on the post (flat list,
// each row carries `parentCommentId` + `depth`). The FE builds the tree and
// decides the visual depth-5 cap + "Read more comments" UX.
//
// No pagination yet: pigweed scale doesn't need it. When a single post hits
// thousands of comments, add pagination keyed on top-level threads (each
// page bundles a top-level comment plus its full subtree, so the tree never
// gets cut mid-branch).
comments.get("/posts/:postId/comments", optionalSignIn, async (c) => {
  const postId = c.req.param("postId");

  const post = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true },
  });
  if (!post) return c.json({ error: "post not found" }, 404);

  const rows = await prisma.comment.findMany({
    where: { postId },
    orderBy: { createdAt: "asc" },
    select: commentSelect,
  });

  const commentIds = rows.map((r) => r.id);
  const [voteByCommentId, awardsByCommentId] = await Promise.all([
    viewerVotes(c.get("viewerId"), commentIds),
    awardSummaries(commentIds),
  ]);

  return c.json({
    comments: rows.map((r) => ({
      ...redactIfDeleted(r),
      myVote: voteByCommentId.get(r.id) ?? null,
      awards: awardsByCommentId.get(r.id) ?? [],
      hidden: r.upvoteCount - r.downvoteCount < HIDE_BELOW_SCORE,
    })),
  });
});

// GET /comments/:id/replies — parent stub + ALL descendants (recursive).
// Used both for the standalone sub-thread page AND for the "Read more
// comments" expansion when a depth-5 comment has hidden children.
//
// Implementation note: we don't store a materialized path column, so we
// can't query descendants directly. Two-step approach:
//   1. Fetch the parent to learn its postId.
//   2. Fetch every comment on that post, then BFS in app code to collect
//      just the subtree rooted at the requested comment.
// Slightly wasteful (loads sibling subtrees we won't return) but trivial
// at pigweed scale and avoids raw SQL. If posts ever carry 10k+ comments,
// switch to a `path` column (materialized path) — one indexed LIKE query.
comments.get("/comments/:id/replies", optionalSignIn, async (c) => {
  const id = c.req.param("id");

  // Parent is NOT filtered by deletedAt — replies under a deleted parent
  // still render, with the parent shown as "[deleted]".
  const parent = await prisma.comment.findUnique({
    where: { id },
    select: commentSelect,
  });
  if (!parent) return c.json({ error: "comment not found" }, 404);

  const allOnPost = await prisma.comment.findMany({
    where: { postId: parent.postId },
    orderBy: { createdAt: "asc" },
    select: commentSelect,
  });

  // Build a parentId → children map once, then BFS from the requested comment.
  const childrenByParent = new Map<string, typeof allOnPost>();
  for (const row of allOnPost) {
    if (!row.parentCommentId) continue;
    const arr = childrenByParent.get(row.parentCommentId) ?? [];
    arr.push(row);
    childrenByParent.set(row.parentCommentId, arr);
  }

  const descendants: typeof allOnPost = [];
  const queue: string[] = [id];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const kids = childrenByParent.get(pid) ?? [];
    for (const kid of kids) {
      descendants.push(kid);
      queue.push(kid.id);
    }
  }

  const allIds = [parent.id, ...descendants.map((d) => d.id)];
  const [voteByCommentId, awardsByCommentId] = await Promise.all([
    viewerVotes(c.get("viewerId"), allIds),
    awardSummaries(allIds),
  ]);

  return c.json({
    parent: {
      ...redactIfDeleted(parent),
      myVote: voteByCommentId.get(parent.id) ?? null,
      awards: awardsByCommentId.get(parent.id) ?? [],
      hidden: parent.upvoteCount - parent.downvoteCount < HIDE_BELOW_SCORE,
    },
    comments: descendants.map((d) => ({
      ...redactIfDeleted(d),
      myVote: voteByCommentId.get(d.id) ?? null,
      awards: awardsByCommentId.get(d.id) ?? [],
      hidden: d.upvoteCount - d.downvoteCount < HIDE_BELOW_SCORE,
    })),
  });
});

// PATCH /comments/:id — author only, only `body` is editable
comments.patch("/comments/:id", requireSignIn, async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);

  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (text.length === 0 || text.length > BODY_MAX) {
    return c.json({ error: `body must be 1-${BODY_MAX} chars` }, 400);
  }

  const existing = await prisma.comment.findFirst({
    where: { id, deletedAt: null },
    select: { authorId: true },
  });
  if (!existing) return c.json({ error: "comment not found" }, 404);
  if (existing.authorId !== userId) return c.json({ error: "not your comment" }, 403);

  const comment = await prisma.comment.update({
    where: { id },
    data: { body: text },
    select: commentSelect,
  });

  return c.json({ comment });
});

// DELETE /comments/:id — author only, soft delete
comments.delete("/comments/:id", requireSignIn, async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const existing = await prisma.comment.findFirst({
    where: { id, deletedAt: null },
    select: { authorId: true },
  });
  if (!existing) return c.json({ error: "comment not found" }, 404);
  if (existing.authorId !== userId) return c.json({ error: "not your comment" }, 403);

  await prisma.comment.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return c.json({ ok: true });
});
