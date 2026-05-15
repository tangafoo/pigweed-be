import { prisma } from "./db";
import { bus } from "../events/bus";
import { AchievementMetric } from "../generated/prisma/client";

// ─────────────────────────────────────────────────────────────
// ACHIEVEMENT ENGINE
//
// Event-driven. Listens to the in-process bus, evaluates the user's
// current value for the relevant metric, and grants any achievements
// they've cleared (and haven't already earned). Each grant atomically
// inserts a UserAchievement row + credits rewardCoins to coinBalance.
// On grant, emits achievement_unlocked so SSE streams can push it to
// the connected client.
//
// Adding a new achievement key = INSERT a row in the Achievement table.
// Adding a new metric = enum migration + one new case in the metric →
// COUNT mapper below.
// ─────────────────────────────────────────────────────────────

// One round-trip per metric. The DB does the counting; we just ask.
async function evaluateMetric(
  userId: string,
  metric: AchievementMetric,
): Promise<number> {
  switch (metric) {
    case "POSTS_CREATED":
      return prisma.post.count({
        where: { authorId: userId, deletedAt: null },
      });
    case "COMMENTS_CREATED":
      return prisma.comment.count({
        where: { authorId: userId, deletedAt: null },
      });
    case "AWARDS_GRANTED": {
      const [postAwardsGranted, commentAwardsGranted] = await Promise.all([
        prisma.postAward.count({ where: { granterId: userId } }),
        prisma.commentAward.count({ where: { granterId: userId } }),
      ]);
      return postAwardsGranted + commentAwardsGranted;
    }
  }
}

// Fetches all candidate achievements for a metric, evaluates the user's
// value once, then attempts to grant each one they've cleared. Existing
// grants are skipped silently via the composite-PK uniqueness on
// UserAchievement — P2002 means "already granted," we ignore.
async function checkAchievementsForMetric(
  userId: string,
  metric: AchievementMetric,
): Promise<void> {
  const candidates = await prisma.achievement.findMany({
    where: { metric, active: true },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      threshold: true,
      rewardCoins: true,
    },
  });
  if (candidates.length === 0) return;

  const value = await evaluateMetric(userId, metric);

  for (const a of candidates) {
    if (value < a.threshold) continue;

    try {
      const [, updatedUser] = await prisma.$transaction([
        prisma.userAchievement.create({
          data: { userId, achievementId: a.id, rewardCoins: a.rewardCoins },
        }),
        prisma.user.update({
          where: { id: userId },
          data: { coinBalance: { increment: a.rewardCoins } },
          select: { coinBalance: true },
        }),
      ]);

      bus.emit({
        type: "achievement_unlocked",
        userId,
        achievement: {
          id: a.id,
          key: a.key,
          name: a.name,
          description: a.description,
          rewardCoins: a.rewardCoins,
        },
        newCoinBalance: updatedUser.coinBalance,
      });
    } catch (err: any) {
      // P2002 = unique constraint violation = already granted. Expected
      // when a re-trigger fires (e.g., user makes their 101st post after
      // already earning "hundred_posts"). Anything else is real.
      if (err?.code !== "P2002") {
        console.error(`[achievements] grant failed for ${a.key}:`, err);
      }
    }
  }
}

// Subscribe at module-load. The bus holds the references; this function
// just wires the routing once.
export function registerAchievementListeners(): void {
  bus.on("post_created", ({ userId }) =>
    checkAchievementsForMetric(userId, "POSTS_CREATED"),
  );
  bus.on("comment_created", ({ userId }) =>
    checkAchievementsForMetric(userId, "COMMENTS_CREATED"),
  );
  bus.on("award_granted", ({ granterId }) =>
    checkAchievementsForMetric(granterId, "AWARDS_GRANTED"),
  );
}
