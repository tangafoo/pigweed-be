import { Hono } from "hono";
import { prisma } from "../utils/db";
import { makeId, ID_PREFIX } from "../utils/ids";
import { bus } from "../events/bus";
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

    bus.emit({ type: "award_granted", granterId });

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

    bus.emit({ type: "award_granted", granterId });

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
// Gated: a viewer sees the attributed list when they are the
// post/comment author (free, recipients always see who gifted
// them) OR they have already spent an unlockCoin on this target
// (a row in Post/CommentGrantersUnlock exists for them).
//
// Anonymous viewers get 401. Signed-in non-author without an
// unlock gets 402 — "use an unlockCoin to view, you have N".
// ─────────────────────────────────────────────────────────────

awards.get("/posts/:postId/awards/granters", requireSignIn, async (c) => {
  const viewerId = c.get("userId");
  const postId = c.req.param("postId");

  const post = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true, authorId: true },
  });
  if (!post) return c.json({ error: "post not found" }, 404);

  if (post.authorId !== viewerId) {
    const unlock = await prisma.postGrantersUnlock.findUnique({
      where: { userId_postId: { userId: viewerId, postId } },
      select: { unlockedAt: true },
    });
    if (!unlock) {
      const wallet = await prisma.user.findUnique({
        where: { id: viewerId },
        select: { unlockCoins: true },
      });
      return c.json(
        {
          error: "granters list is locked",
          unlockCoins: wallet?.unlockCoins ?? 0,
          unlockEndpoint: `/posts/${postId}/awards/granters/unlock`,
        },
        402,
      );
    }
  }

  const rows = await prisma.postAward.findMany({
    where: { postId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      granter: { select: { id: true, username: true, gender: true, animal: true, avatarSeed: true } },
      awardType: { select: { id: true, assetKey: true, name: true } },
    },
  });

  return c.json({ granters: rows });
});

awards.get("/comments/:commentId/awards/granters", requireSignIn, async (c) => {
  const viewerId = c.get("userId");
  const commentId = c.req.param("commentId");

  const comment = await prisma.comment.findFirst({
    where: { id: commentId, deletedAt: null },
    select: { id: true, authorId: true },
  });
  if (!comment) return c.json({ error: "comment not found" }, 404);

  if (comment.authorId !== viewerId) {
    const unlock = await prisma.commentGrantersUnlock.findUnique({
      where: { userId_commentId: { userId: viewerId, commentId } },
      select: { unlockedAt: true },
    });
    if (!unlock) {
      const wallet = await prisma.user.findUnique({
        where: { id: viewerId },
        select: { unlockCoins: true },
      });
      return c.json(
        {
          error: "granters list is locked",
          unlockCoins: wallet?.unlockCoins ?? 0,
          unlockEndpoint: `/comments/${commentId}/awards/granters/unlock`,
        },
        402,
      );
    }
  }

  const rows = await prisma.commentAward.findMany({
    where: { commentId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      createdAt: true,
      granter: { select: { id: true, username: true, gender: true, animal: true, avatarSeed: true } },
      awardType: { select: { id: true, assetKey: true, name: true } },
    },
  });

  return c.json({ granters: rows });
});

// ─────────────────────────────────────────────────────────────
// UNLOCK — POST /posts/:postId/awards/granters/unlock
//          POST /comments/:commentId/awards/granters/unlock
//
// Spends one unlockCoin from the viewer's wallet to permanently
// unlock the granter list for this specific target. Idempotent
// — calling again when already unlocked returns 200 with no
// charge. Atomic decrement gates the spend (Postgres rejects
// the update if unlockCoins < 1).
// ─────────────────────────────────────────────────────────────

awards.post("/posts/:postId/awards/granters/unlock", requireSignIn, async (c) => {
  const viewerId = c.get("userId");
  const postId = c.req.param("postId");

  const post = await prisma.post.findFirst({
    where: { id: postId, deletedAt: null },
    select: { id: true, authorId: true },
  });
  if (!post) return c.json({ error: "post not found" }, 404);

  if (post.authorId === viewerId) {
    return c.json({ alreadyUnlocked: true, reason: "author" });
  }

  const existing = await prisma.postGrantersUnlock.findUnique({
    where: { userId_postId: { userId: viewerId, postId } },
    select: { unlockedAt: true },
  });
  if (existing) return c.json({ alreadyUnlocked: true, unlockedAt: existing.unlockedAt });

  try {
    const [updatedUser] = await prisma.$transaction([
      prisma.user.update({
        where: { id: viewerId, unlockCoins: { gte: 1 } },
        data: { unlockCoins: { decrement: 1 } },
        select: { unlockCoins: true },
      }),
      prisma.postGrantersUnlock.create({
        data: { userId: viewerId, postId },
        select: { unlockedAt: true },
      }),
    ]);

    return c.json({ unlocked: true, unlockCoinsRemaining: updatedUser.unlockCoins }, 201);
  } catch (err: any) {
    if (err?.code === "P2025") {
      return c.json({ error: "no unlockCoins available — grant more awards to earn some" }, 402);
    }
    throw err;
  }
});

awards.post("/comments/:commentId/awards/granters/unlock", requireSignIn, async (c) => {
  const viewerId = c.get("userId");
  const commentId = c.req.param("commentId");

  const comment = await prisma.comment.findFirst({
    where: { id: commentId, deletedAt: null },
    select: { id: true, authorId: true },
  });
  if (!comment) return c.json({ error: "comment not found" }, 404);

  if (comment.authorId === viewerId) {
    return c.json({ alreadyUnlocked: true, reason: "author" });
  }

  const existing = await prisma.commentGrantersUnlock.findUnique({
    where: { userId_commentId: { userId: viewerId, commentId } },
    select: { unlockedAt: true },
  });
  if (existing) return c.json({ alreadyUnlocked: true, unlockedAt: existing.unlockedAt });

  try {
    const [updatedUser] = await prisma.$transaction([
      prisma.user.update({
        where: { id: viewerId, unlockCoins: { gte: 1 } },
        data: { unlockCoins: { decrement: 1 } },
        select: { unlockCoins: true },
      }),
      prisma.commentGrantersUnlock.create({
        data: { userId: viewerId, commentId },
        select: { unlockedAt: true },
      }),
    ]);

    return c.json({ unlocked: true, unlockCoinsRemaining: updatedUser.unlockCoins }, 201);
  } catch (err: any) {
    if (err?.code === "P2025") {
      return c.json({ error: "no unlockCoins available — grant more awards to earn some" }, 402);
    }
    throw err;
  }
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
