import { Hono } from "hono";
import { prisma } from "../utils/db";
import { makeId, ID_PREFIX } from "../utils/ids";
import { requireSignIn, type AuthVars } from "../middleware/require-sign-in";

export const awards = new Hono<AuthVars>();

// ─────────────────────────────────────────────────────────────
// GRANT — POST /posts/:postId/awards and /comments/:commentId/awards
//
// Spends the granter's coins and creates the award row in one
// $transaction. We snapshot the AwardType's current priceCoins onto the
// award row (`coinsSpent`) so future price changes don't rewrite history.
//
// Insufficient-balance is checked with an *atomic* decrement: the update
// uses a WHERE clause that requires the balance to still be >= price at
// the moment Postgres runs the row update. Two concurrent grants from the
// same wallet cannot both pass — the second sees a balance below the
// threshold and the update affects zero rows, which Prisma surfaces as a
// not-found error. We catch that and 400.
// ─────────────────────────────────────────────────────────────

async function loadActiveAwardType(awardTypeId: unknown) {
  if (typeof awardTypeId !== "string" || awardTypeId.length === 0) {
    return { error: "awardTypeId is required" as const };
  }
  const type = await prisma.awardType.findFirst({
    where: { id: awardTypeId, active: true },
    select: { id: true, assetKey: true, name: true, priceCoins: true },
  });
  if (!type) return { error: "award type not found" as const };
  return { type };
}

awards.post("/posts/:postId/awards", requireSignIn, async (c) => {
  const granterId = c.get("userId");
  const postId = c.req.param("postId");
  const body = await c.req.json().catch(() => null);

  const loaded = await loadActiveAwardType(body?.awardTypeId);
  if ("error" in loaded) return c.json({ error: loaded.error }, 400);
  const awardType = loaded.type;

  const post = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true },
  });
  if (!post) return c.json({ error: "post not found" }, 404);

  try {
    const [, awardRow] = await prisma.$transaction([
      prisma.user.update({
        // Atomic gate: only updates if balance is still >= price. If not,
        // Prisma throws RecordNotFound, which we catch below.
        where: { id: granterId, coinBalance: { gte: awardType.priceCoins } },
        data: { coinBalance: { decrement: awardType.priceCoins } },
      }),
      prisma.postAward.create({
        data: {
          id: makeId(ID_PREFIX.POST_AWARD),
          granterId,
          postId,
          awardTypeId: awardType.id,
          coinsSpent: awardType.priceCoins,
        },
        select: { id: true, awardTypeId: true, coinsSpent: true, createdAt: true },
      }),
    ]);

    return c.json({ award: awardRow, awardType }, 201);
  } catch (err: any) {
    if (err?.code === "P2025") {
      return c.json({ error: "insufficient coin balance" }, 400);
    }
    throw err;
  }
});

awards.post("/comments/:commentId/awards", requireSignIn, async (c) => {
  const granterId = c.get("userId");
  const commentId = c.req.param("commentId");
  const body = await c.req.json().catch(() => null);

  const loaded = await loadActiveAwardType(body?.awardTypeId);
  if ("error" in loaded) return c.json({ error: loaded.error }, 400);
  const awardType = loaded.type;

  const comment = await prisma.comment.findFirst({
    where: { id: commentId, deletedAt: null },
    select: { id: true },
  });
  if (!comment) return c.json({ error: "comment not found" }, 404);

  try {
    const [, awardRow] = await prisma.$transaction([
      prisma.user.update({
        where: { id: granterId, coinBalance: { gte: awardType.priceCoins } },
        data: { coinBalance: { decrement: awardType.priceCoins } },
      }),
      prisma.commentAward.create({
        data: {
          id: makeId(ID_PREFIX.COMMENT_AWARD),
          granterId,
          commentId,
          awardTypeId: awardType.id,
          coinsSpent: awardType.priceCoins,
        },
        select: { id: true, awardTypeId: true, coinsSpent: true, createdAt: true },
      }),
    ]);

    return c.json({ award: awardRow, awardType }, 201);
  } catch (err: any) {
    if (err?.code === "P2025") {
      return c.json({ error: "insufficient coin balance" }, 400);
    }
    throw err;
  }
});

// ─────────────────────────────────────────────────────────────
// GRANTERS — GET /posts/:postId/awards/granters
//           GET /comments/:commentId/awards/granters
//
// Returns the full attributed list (who gave which award when).
// Public for now. Phase 2 will gate this behind a per-viewer
// pay-to-unlock; the data shape stays the same.
// ─────────────────────────────────────────────────────────────

awards.get("/posts/:postId/awards/granters", async (c) => {
  const postId = c.req.param("postId");

  const post = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true },
  });
  if (!post) return c.json({ error: "post not found" }, 404);

  const rows = await prisma.postAward.findMany({
    where: { postId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      granter: { select: { id: true, name: true, image: true } },
      awardType: { select: { id: true, assetKey: true, name: true } },
    },
  });

  return c.json({ granters: rows });
});

awards.get("/comments/:commentId/awards/granters", async (c) => {
  const commentId = c.req.param("commentId");

  const comment = await prisma.comment.findFirst({
    where: { id: commentId, deletedAt: null },
    select: { id: true },
  });
  if (!comment) return c.json({ error: "comment not found" }, 404);

  const rows = await prisma.commentAward.findMany({
    where: { commentId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      granter: { select: { id: true, name: true, image: true } },
      awardType: { select: { id: true, assetKey: true, name: true } },
    },
  });

  return c.json({ granters: rows });
});

// ─────────────────────────────────────────────────────────────
// CATALOG — GET /awards/types
// Lists active award types so the frontend can render the "gift"
// picker. Public, no auth.
// ─────────────────────────────────────────────────────────────

awards.get("/awards/types", async (c) => {
  const types = await prisma.awardType.findMany({
    where: { active: true },
    orderBy: { priceCoins: "asc" },
    select: { id: true, assetKey: true, name: true, priceCoins: true },
  });
  return c.json({ types });
});
