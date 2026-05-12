import { Hono } from "hono";
import { prisma } from "../utils/db";
import { VoteValue } from "../generated/prisma/client";
import { makeId, ID_PREFIX } from "../utils/ids";
import { requireSignIn, type AuthVars } from "../middleware/require-sign-in";
import { optionalSignIn, type ViewerVars } from "../middleware/optional-sign-in";

export const comments = new Hono<AuthVars & ViewerVars>();

const BODY_MAX = 5000;

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

  const comment = await prisma.comment.create({
    data: { id: makeId(ID_PREFIX.COMMENT), postId, authorId: userId, parentCommentId, depth, body: text },
    select: commentSelect,
  });

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

  const voteByCommentId = await viewerVotes(c.get("viewerId"), rows.map((r) => r.id));

  return c.json({
    comments: rows.map((r) => ({
      ...redactIfDeleted(r),
      myVote: voteByCommentId.get(r.id) ?? null,
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

  const voteByCommentId = await viewerVotes(
    c.get("viewerId"),
    [parent.id, ...descendants.map((d) => d.id)],
  );

  return c.json({
    parent: { ...redactIfDeleted(parent), myVote: voteByCommentId.get(parent.id) ?? null },
    comments: descendants.map((d) => ({
      ...redactIfDeleted(d),
      myVote: voteByCommentId.get(d.id) ?? null,
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
