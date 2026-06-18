import { Hono } from "hono";
import { prisma } from "../utils/db";
import { VoteValue, Prisma, PostCategory } from "../generated/prisma/client";
import { makeId, ID_PREFIX } from "../utils/ids";
import { bus } from "../events/bus";
import { isValidLatLng, DEFAULT_RADIUS_KM } from "../utils/geo";
import { RANKING_WEIGHTS } from "../utils/ranking";
import { moderate } from "../utils/ai/moderator";
import { r2Config } from "../utils/env";
import { requireSignIn, type AuthVars } from "../middleware/require-sign-in";
import { optionalSignIn, type ViewerVars } from "../middleware/optional-sign-in";

export const posts = new Hono<AuthVars & ViewerVars>();

const VALID_MEDIA_KINDS = ["image", "video", "gif"] as const;
const MAX_MEDIA_PER_POST = 10;
const TITLE_MAX = 200;
const BODY_MAX = 10000;
// Derived from the generated Prisma enum so it can never drift from the
// schema — add a value in schema.prisma + regenerate and this list follows
// automatically (no hand-maintained copy). Posts may carry one category or
// none (owner updates / general chatter live in the "all" bucket).
const VALID_CATEGORIES = Object.values(PostCategory);

function isPostCategory(v: unknown): v is PostCategory {
  return typeof v === "string" && (VALID_CATEGORIES as string[]).includes(v);
}

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
//
// `allowedBaseUrl` (optional): when provided, every media URL must be
// hosted on that origin — this is how we ensure posts only embed media we
// actually uploaded to our own R2 bucket, not arbitrary third-party URLs.
// The route passes r2Config()?.publicBaseUrl; when it's undefined (R2 not
// configured, or in unit tests) enforcement is skipped and any valid URL
// is accepted, preserving the original permissive behavior.
export function parseMedia(
  input: unknown,
  allowedBaseUrl?: string,
): MediaInput[] | { error: string } {
  if (input == null) return [];
  if (!Array.isArray(input)) return { error: "media must be an array" };
  if (input.length > MAX_MEDIA_PER_POST) {
    return { error: `media cannot exceed ${MAX_MEDIA_PER_POST} items` };
  }

  // Compare by ORIGIN, not string prefix — `startsWith` would let
  // `https://media.ourlittlefarm.club.evil.com/...` through. Parsed once.
  let allowedOrigin: string | null = null;
  if (allowedBaseUrl) {
    try {
      allowedOrigin = new URL(allowedBaseUrl).origin;
    } catch {
      allowedOrigin = null; // misconfigured base ⇒ don't enforce (fail open)
    }
  }

  const out: MediaInput[] = [];
  for (let i = 0; i < input.length; i++) {
    const m = input[i];
    if (typeof m?.url !== "string" || !isValidUrl(m.url)) {
      return { error: `media[${i}].url must be a valid URL` };
    }
    if (allowedOrigin && new URL(m.url).origin !== allowedOrigin) {
      return { error: `media[${i}].url must be hosted on the app's media domain` };
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

type AwardSummaryRow = {
  awardTypeId: string;
  assetKey: string;
  name: string;
  count: number;
};

// Build a postId → AwardSummaryRow[] map. Each summary aggregates by award
// type (anonymous — granters live behind /posts/:id/awards/granters). Sorted
// by count desc so the frontend can slice top-N for the bushy/stacked preview.
async function awardSummaries(postIds: string[]): Promise<Map<string, AwardSummaryRow[]>> {
  if (postIds.length === 0) return new Map();

  const rows = await prisma.postAward.findMany({
    where: { postId: { in: postIds } },
    select: {
      postId: true,
      awardTypeId: true,
      awardType: { select: { assetKey: true, name: true } },
    },
  });

  // Two-level group: postId → awardTypeId → counter row
  const byPost = new Map<string, Map<string, AwardSummaryRow>>();
  for (const r of rows) {
    let inner = byPost.get(r.postId);
    if (!inner) {
      inner = new Map();
      byPost.set(r.postId, inner);
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
  for (const [postId, inner] of byPost) {
    const arr = Array.from(inner.values());
    arr.sort((a, b) => b.count - a.count);
    out.set(postId, arr);
  }
  return out;
}

// Shape returned on every post-fetching endpoint. Defined once so the
// list/get/create/patch responses stay in lockstep.
const postSelect = {
  id: true,
  title: true,
  body: true,
  latitude: true,
  longitude: true,
  createdAt: true,
  updatedAt: true,
  upvoteCount: true,
  downvoteCount: true,
  moderated: true,
  category: true,
  rating: true,
  author: {
    select: {
      id: true,
      username: true,
      gender: true,
      animal: true,
      avatarSeed: true,
      isFarmOwner: true,
    },
  },
  media: {
    select: { id: true, url: true, kind: true, order: true, width: true, height: true },
    orderBy: { order: "asc" as const },
  },
} as const;

posts.get("/", optionalSignIn, async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));

  // Optional geo filter — FE passes ?lat=&lng= (and optionally ?radius=).
  // If absent, the feed returns everything (back-compat, "browse all" UX).
  const latStr = c.req.query("lat");
  const lngStr = c.req.query("lng");
  const radiusStr = c.req.query("radius");
  const viewerLocation = isValidLatLng({ latitude: Number(latStr), longitude: Number(lngStr) })
    ? { latitude: Number(latStr), longitude: Number(lngStr) }
    : null;
  const radiusKm = Number.isFinite(Number(radiusStr)) && Number(radiusStr) > 0
    ? Number(radiusStr)
    : DEFAULT_RADIUS_KM;

  // Content filters (all optional, all combine). `authorId` powers the
  // profile "posts" tab; `category` + `minRating` power the /posts page
  // section + star filters. Invalid values are ignored (treated as absent).
  const authorId = c.req.query("authorId") || undefined;
  const categoryParam = c.req.query("category");
  const category = isPostCategory(categoryParam) ? categoryParam : undefined;
  const minRatingNum = Number(c.req.query("minRating"));
  const minRating =
    Number.isInteger(minRatingNum) && minRatingNum >= 1 && minRatingNum <= 5
      ? minRatingNum
      : undefined;

  // Built once, applied to both code paths: a Prisma `where` object for the
  // findMany branch, and matching raw-SQL `AND` fragments for the geo branch.
  // Columns are unqualified — they're unambiguous (only `post` has them) in
  // both the single-table newest query and the post⋈user rank query.
  const filterFragments: Prisma.Sql[] = [];
  if (authorId) filterFragments.push(Prisma.sql`AND "authorId" = ${authorId}`);
  if (category) filterFragments.push(Prisma.sql`AND "category" = ${category}::"post_category"`);
  if (minRating != null) filterFragments.push(Prisma.sql`AND "rating" >= ${minRating}`);
  const filterSql = filterFragments.length ? Prisma.join(filterFragments, " ") : Prisma.empty;

  // Sort mode. ?sort=rank → composite score (the "hot" feed). Anything
  // else → newest first. Ranking REQUIRES geo (the formula has a
  // distance term); fall back silently to newest if geo is missing.
  const sortMode = c.req.query("sort") === "rank" && viewerLocation ? "rank" : "newest";

  // Viewer's animal for affinity. Derived server-side from the signed-in
  // user — NOT trusted from any client input. If the request is anonymous
  // or sort isn't rank, we skip the lookup entirely.
  const viewerId = c.get("viewerId");
  const viewerAnimal =
    sortMode === "rank" && viewerId
      ? (await prisma.user.findUnique({
          where: { id: viewerId },
          select: { animal: true },
        }))?.animal ?? ""
      : "";

  // PostGIS does the radius math. The `geo` column on post is a generated
  // geography(Point, 4326) maintained by Postgres from latitude/longitude;
  // a GIST index makes ST_DWithin sub-millisecond regardless of post count.
  // ST_DWithin takes distance in METERS (hence radiusKm * 1000).
  //
  // We $queryRaw for the matching IDs (with ordering + pagination at the
  // DB), then a regular Prisma findMany resolves the full payload through
  // postSelect so we don't have to hand-roll the relation joins.
  let rows: Array<typeof postSelect extends infer _ ? any : never>;
  if (viewerLocation) {
    const offset = (page - 1) * limit;

    // Both sort modes use $queryRaw — newest still needs ST_DWithin for
    // the radius filter; rank additionally orders by the composite score.
    // The score math runs entirely in Postgres so OFFSET/LIMIT pagination
    // works correctly (no JS-side re-sorting that could break pages).
    const idRows = sortMode === "rank"
      ? await prisma.$queryRaw<{ id: string }[]>`
          SELECT post.id
          FROM "post"
          LEFT JOIN "user" ON "user".id = post."authorId"
          WHERE post."deletedAt" IS NULL
            AND ST_DWithin(
              post.geo,
              ST_SetSRID(ST_MakePoint(${viewerLocation.longitude}, ${viewerLocation.latitude}), 4326)::geography,
              ${radiusKm * 1000}
            )
            ${filterSql}
          ORDER BY (
            -${RANKING_WEIGHTS.geoPerKm} * (
              ST_Distance(post.geo, ST_SetSRID(ST_MakePoint(${viewerLocation.longitude}, ${viewerLocation.latitude}), 4326)::geography) / 1000.0
            )
            + ${RANKING_WEIGHTS.votesGain} * (post."upvoteCount" - post."downvoteCount")
              / GREATEST(1, EXTRACT(EPOCH FROM (NOW() - post."createdAt")) / 3600.0 + 2.0)
            + CASE WHEN "user".animal::text = ${viewerAnimal} THEN ${RANKING_WEIGHTS.affinityBonus} ELSE 0 END
          ) DESC
          LIMIT ${limit} OFFSET ${offset}
        `
      : await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "post"
          WHERE "deletedAt" IS NULL
            AND ST_DWithin(
              geo,
              ST_SetSRID(ST_MakePoint(${viewerLocation.longitude}, ${viewerLocation.latitude}), 4326)::geography,
              ${radiusKm * 1000}
            )
            ${filterSql}
          ORDER BY "createdAt" DESC
          LIMIT ${limit} OFFSET ${offset}
        `;

    const ids = idRows.map((r) => r.id);
    const fetched = await prisma.post.findMany({
      where: { id: { in: ids } },
      select: postSelect,
    });
    // findMany doesn't preserve the IN-clause order; re-sort to match
    // whatever ORDER BY the raw query gave us.
    const byId = new Map(fetched.map((p) => [p.id, p]));
    rows = ids.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => p != null);
  } else {
    rows = await prisma.post.findMany({
      where: {
        deletedAt: null,
        ...(authorId ? { authorId } : {}),
        ...(category ? { category } : {}),
        ...(minRating != null ? { rating: { gte: minRating } } : {}),
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: postSelect,
    });
  }

  const postIds = rows.map((r) => r.id);
  const [voteByPostId, awardsByPostId] = await Promise.all([
    viewerVotes(viewerId, postIds),
    awardSummaries(postIds),
  ]);

  return c.json({
    posts: rows.map((r) => ({
      ...r,
      myVote: voteByPostId.get(r.id) ?? null,
      awards: awardsByPostId.get(r.id) ?? [],
    })),
    page,
    limit,
    radiusKm: viewerLocation ? radiusKm : null,
    sort: sortMode,
  });
});

posts.get("/:id", optionalSignIn, async (c) => {
  const id = c.req.param("id");
  const post = await prisma.post.findFirst({
    where: { id, deletedAt: null },
    select: postSelect,
  });
  if (!post) return c.json({ error: "post not found" }, 404);

  const [voteByPostId, awardsByPostId] = await Promise.all([
    viewerVotes(c.get("viewerId"), [post.id]),
    awardSummaries([post.id]),
  ]);

  return c.json({
    post: {
      ...post,
      myVote: voteByPostId.get(post.id) ?? null,
      awards: awardsByPostId.get(post.id) ?? [],
    },
  });
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

  // Geo is REQUIRED. Pigweed posts are location-anchored — there's no
  // such thing as a placeless post. The FE provides the user's current
  // coords from the browser geolocation API.
  if (!isValidLatLng(body ?? {})) {
    return c.json({ error: "latitude and longitude required in body" }, 400);
  }
  const latitude = body.latitude;
  const longitude = body.longitude;

  // Optional produce category. Omit/null → uncategorized; any other value
  // must be a known PostCategory.
  let category: PostCategory | null = null;
  if (body?.category != null) {
    if (!isPostCategory(body.category)) {
      return c.json({ error: `category must be one of ${VALID_CATEGORIES.join(", ")}` }, 400);
    }
    category = body.category;
  }

  // Optional 1–5 review rating. Omit/null → not a review.
  let rating: number | null = null;
  if (body?.rating != null) {
    if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5) {
      return c.json({ error: "rating must be an integer 1-5" }, 400);
    }
    rating = body.rating;
  }

  // Enforce that embedded media lives on our own R2 domain (when R2 is
  // configured). Prevents posts from hot-linking arbitrary external URLs.
  const mediaResult = parseMedia(body?.media, r2Config()?.publicBaseUrl);
  if (!Array.isArray(mediaResult)) return c.json(mediaResult, 400);

  // Moderation gate — title + body checked together. Fail-open inside
  // moderate(); a block here means it genuinely tripped a category.
  const mod = await moderate(`${title}\n\n${content}`);
  if (!mod.allowed) {
    console.log(`[posts] blocked post by ${userId} — flagged: ${mod.categories.join(", ")}`);
    return c.json(
      { error: `flagged for ${mod.reason}`, code: "CONTENT_FLAGGED", rejectedCategories: mod.categories },
      422,
    );
  }

  const post = await prisma.post.create({
    data: {
      id: makeId(ID_PREFIX.POST),
      authorId: userId,
      title,
      body: content,
      latitude,
      longitude,
      category,
      rating,
      moderated: mod.moderated,
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

  bus.emit({ type: "post_created", userId });

  console.log(
    `[posts] created ${post.id} by ${userId} (category=${category ?? "none"}, rating=${rating ?? "none"}, media=${mediaResult.length})`,
  );

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

  const updates: {
    title?: string;
    body?: string;
    category?: PostCategory | null;
    rating?: number | null;
  } = {};
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
  // category/rating: `null` clears, a valid value sets, `undefined` (absent) leaves.
  if (body?.category !== undefined) {
    if (body.category !== null && !isPostCategory(body.category)) {
      return c.json({ error: `category must be one of ${VALID_CATEGORIES.join(", ")}` }, 400);
    }
    updates.category = body.category;
  }
  if (body?.rating !== undefined) {
    if (
      body.rating !== null &&
      (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5)
    ) {
      return c.json({ error: "rating must be an integer 1-5" }, 400);
    }
    updates.rating = body.rating;
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
