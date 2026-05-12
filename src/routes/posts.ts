import { Hono } from "hono";
import { prisma } from "../utils/db";
import { VoteValue } from "../generated/prisma/client";
import { makeId, ID_PREFIX } from "../utils/ids";
import { requireSignIn, type AuthVars } from "../middleware/require-sign-in";
import { optionalSignIn, type ViewerVars } from "../middleware/optional-sign-in";

export const posts = new Hono<AuthVars & ViewerVars>();

const VALID_MEDIA_KINDS = ["image", "video", "gif"] as const;
const MAX_MEDIA_PER_POST = 10;
const TITLE_MAX = 200;
const BODY_MAX = 10000;

type MediaInput = {
  url: string;
  kind: string;
  order: number;
  width?: number;
  height?: number;
};

function isValidUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

// Returns parsed media OR a string error message. Discriminated union
// would be tidier but this is small enough that "string = error" works.
export function parseMedia(input: unknown): MediaInput[] | { error: string } {
  if (input == null) return [];
  if (!Array.isArray(input)) return { error: "media must be an array" };
  if (input.length > MAX_MEDIA_PER_POST) {
    return { error: `media cannot exceed ${MAX_MEDIA_PER_POST} items` };
  }

  const out: MediaInput[] = [];
  for (let i = 0; i < input.length; i++) {
    const m = input[i];
    if (typeof m?.url !== "string" || !isValidUrl(m.url)) {
      return { error: `media[${i}].url must be a valid URL` };
    }
    if (typeof m?.kind !== "string" || !VALID_MEDIA_KINDS.includes(m.kind as never)) {
      return { error: `media[${i}].kind must be one of ${VALID_MEDIA_KINDS.join(", ")}` };
    }
    const order = typeof m.order === "number" ? m.order : i;
    if (!Number.isInteger(order) || order < 0) {
      return { error: `media[${i}].order must be a non-negative integer` };
    }
    const width = typeof m.width === "number" ? m.width : undefined;
    const height = typeof m.height === "number" ? m.height : undefined;
    if (width !== undefined && (!Number.isInteger(width) || width < 0)) {
      return { error: `media[${i}].width must be a non-negative integer` };
    }
    if (height !== undefined && (!Number.isInteger(height) || height < 0)) {
      return { error: `media[${i}].height must be a non-negative integer` };
    }

    out.push({ url: m.url, kind: m.kind, order, width, height });
  }
  return out;
}

// Build a postId → vote-value map for the current viewer over the given
// set of posts. Returns an empty map when the viewer is anonymous or the
// id list is empty (no DB call in those cases).
async function viewerVotes(
  viewerId: string | undefined,
  postIds: string[],
): Promise<Map<string, VoteValue>> {
  if (!viewerId || postIds.length === 0) return new Map();
  const votes = await prisma.postVote.findMany({
    where: { userId: viewerId, postId: { in: postIds } },
    select: { postId: true, value: true },
  });
  return new Map(votes.map((v) => [v.postId, v.value]));
}

// Shape returned on every post-fetching endpoint. Defined once so the
// list/get/create/patch responses stay in lockstep.
const postSelect = {
  id: true,
  title: true,
  body: true,
  createdAt: true,
  updatedAt: true,
  upvoteCount: true,
  downvoteCount: true,
  author: { select: { id: true, name: true, image: true } },
  media: {
    select: { id: true, url: true, kind: true, order: true, width: true, height: true },
    orderBy: { order: "asc" as const },
  },
} as const;

posts.get("/", optionalSignIn, async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));

  const rows = await prisma.post.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    skip: (page - 1) * limit,
    take: limit,
    select: postSelect,
  });

  const voteByPostId = await viewerVotes(c.get("viewerId"), rows.map((r) => r.id));

  return c.json({
    posts: rows.map((r) => ({ ...r, myVote: voteByPostId.get(r.id) ?? null })),
    page,
    limit,
  });
});

posts.get("/:id", optionalSignIn, async (c) => {
  const id = c.req.param("id");
  const post = await prisma.post.findFirst({
    where: { id, deletedAt: null },
    select: postSelect,
  });
  if (!post) return c.json({ error: "post not found" }, 404);

  const voteByPostId = await viewerVotes(c.get("viewerId"), [post.id]);

  return c.json({ post: { ...post, myVote: voteByPostId.get(post.id) ?? null } });
});

posts.post("/", requireSignIn, async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);

  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const content = typeof body?.body === "string" ? body.body.trim() : "";

  if (title.length === 0 || title.length > TITLE_MAX) {
    return c.json({ error: `title must be 1-${TITLE_MAX} chars` }, 400);
  }
  if (content.length === 0 || content.length > BODY_MAX) {
    return c.json({ error: `body must be 1-${BODY_MAX} chars` }, 400);
  }

  const mediaResult = parseMedia(body?.media);
  if (!Array.isArray(mediaResult)) return c.json(mediaResult, 400);

  const post = await prisma.post.create({
    data: {
      id: makeId(ID_PREFIX.POST),
      authorId: userId,
      title,
      body: content,
      media: mediaResult.length > 0
        ? {
          create: mediaResult.map((m) => ({
            id: makeId(ID_PREFIX.POST_MEDIA),
            url: m.url, kind: m.kind, order: m.order, width: m.width, height: m.height,
          }))
        }
        : undefined,
    },
    select: postSelect,
  });

  return c.json({ post }, 201);
});

posts.patch("/:id", requireSignIn, async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);

  const existing = await prisma.post.findFirst({
    where: { id, deletedAt: null },
    select: { authorId: true },
  });
  if (!existing) return c.json({ error: "post not found" }, 404);
  if (existing.authorId !== userId) return c.json({ error: "not your post" }, 403);

  const updates: { title?: string; body?: string } = {};
  if (typeof body?.title === "string") {
    const t = body.title.trim();
    if (t.length === 0 || t.length > TITLE_MAX) {
      return c.json({ error: `title must be 1-${TITLE_MAX} chars` }, 400);
    }
    updates.title = t;
  }
  if (typeof body?.body === "string") {
    const b = body.body.trim();
    if (b.length === 0 || b.length > BODY_MAX) {
      return c.json({ error: `body must be 1-${BODY_MAX} chars` }, 400);
    }
    updates.body = b;
  }
  if (Object.keys(updates).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }

  const post = await prisma.post.update({
    where: { id },
    data: updates,
    select: postSelect,
  });

  return c.json({ post });
});

posts.delete("/:id", requireSignIn, async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");

  const existing = await prisma.post.findFirst({
    where: { id, deletedAt: null },
    select: { authorId: true },
  });
  if (!existing) return c.json({ error: "post not found" }, 404);
  if (existing.authorId !== userId) return c.json({ error: "not your post" }, 403);

  await prisma.post.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return c.json({ ok: true });
});
