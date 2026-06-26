import { prisma } from "./db";
import { bus } from "../events/bus";
import { sendEmail } from "./email";
import { achievementEmail } from "../emails/templates";
import { appUrl } from "./env";
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
// Exported so the backfill script reuses the EXACT same metric definitions
// (no drift between "what the engine grants" and "what the backfill grants").
export async function evaluateMetric(
  userId: string,
  metric: AchievementMetric,
): Promise<number> {
  switch (metric) {
    case "POSTS_CREATED":
      return prisma.post.count({
        where: { authorId: userId, deletedAt: null },
      });
    case "REVIEWS_CREATED":
      // A "review" is a post that carries a star rating.
      return prisma.post.count({
        where: { authorId: userId, deletedAt: null, rating: { not: null } },
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
    case "MANUAL":
      // Never auto-granted — there is no metric to count. Returning 0 keeps
      // the backfill/engine from ever clearing the threshold; these are
      // awarded only by an explicit grantAchievementByKey() call.
      return 0;
  }
}

// A catalog row, trimmed to what granting needs.
export interface AchievementCandidate {
  id: string;
  key: string;
  name: string;
  description: string;
  threshold: number;
  rewardCoins: number;
}

// Atomically grant ONE achievement: insert the UserAchievement row + credit
// rewardCoins. Returns the recipient's fresh balance/email/username on a real
// grant, or null when it was already granted (P2002 composite-PK dup) or on
// error. Deliberately does NOT email or emit — the caller decides whether to
// notify. The live engine emails+emits after a successful grant; the backfill
// script reuses this and stays silent. This is the single source of truth for
// "what a grant does," so the two paths can never double-credit or drift.
export async function grantAchievement(
  userId: string,
  a: Pick<AchievementCandidate, "id" | "key" | "rewardCoins">,
): Promise<{ coinBalance: number; email: string; username: string } | null> {
  try {
    const [, updatedUser] = await prisma.$transaction([
      prisma.userAchievement.create({
        data: { userId, achievementId: a.id, rewardCoins: a.rewardCoins },
      }),
      prisma.user.update({
        where: { id: userId },
        data: { coinBalance: { increment: a.rewardCoins } },
        select: { coinBalance: true, email: true, username: true },
      }),
    ]);
    return updatedUser;
  } catch (err: any) {
    // P2002 = unique constraint violation = already granted. Expected on a
    // re-trigger (e.g. the 101st post after "hundred_posts"). Anything else
    // is real and worth logging.
    if (err?.code !== "P2002") {
      console.error(`[achievements] grant failed for ${a.key}:`, err);
    }
    return null;
  }
}

// Grant a specific achievement by its catalog `key`, regardless of any
// metric/threshold — for manually-awarded badges like "Founding Flock".
// Silent by design (no email/SSE), matching the admin-toggle UX and the
// "don't email subscribers yet" rule. Idempotent (grantAchievement is
// P2002-safe). Returns true on a fresh grant.
export async function grantAchievementByKey(userId: string, key: string): Promise<boolean> {
  const a = await prisma.achievement.findUnique({
    where: { key },
    select: { id: true, key: true, rewardCoins: true },
  });
  if (!a) {
    console.warn(`[achievements] grantByKey: no achievement "${key}"`);
    return false;
  }
  const granted = await grantAchievement(userId, a);
  return !!granted;
}

// Fetches all candidate achievements for a metric, evaluates the user's
// value once, then grants each one they've cleared (idempotent via
// grantAchievement). On a fresh grant: email (once, at the grant site — see
// note below) + emit the SSE event.
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

    const granted = await grantAchievement(userId, a);
    if (!granted) continue; // already had it, or the grant failed

    // Real-time achievement email. Sent HERE, at the grant site, NOT via a
    // bus listener: achievement_unlocked is a FAN-OUT event (re-emitted on
    // every instance under Redis), so a listener would send one email per
    // instance. This path runs exactly once — on the granting instance.
    // Fire-and-forget; sendEmail fails open.
    const email = achievementEmail({
      username: granted.username,
      achievementName: a.name,
      achievementDescription: a.description,
      rewardCoins: a.rewardCoins,
      newCoinBalance: granted.coinBalance,
      appUrl: appUrl(),
    });
    void sendEmail({ to: granted.email, ...email });

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
      newCoinBalance: granted.coinBalance,
    });

    console.log(
      `[achievements] unlocked "${a.name}" (${a.key}) for ${userId} — +${a.rewardCoins} coins → balance ${granted.coinBalance}`,
    );
  }
}

// Subscribe at module-load. The bus holds the references; this function
// just wires the routing once.
export function registerAchievementListeners(): void {
  // A post can satisfy two metrics at once: every post counts toward
  // POSTS_CREATED, and a rated post also counts toward REVIEWS_CREATED. Both
  // are checked; a first post that's also a review unlocks First Post AND
  // First Review (two distinct achievements, each granted/emailed once).
  bus.on("post_created", async ({ userId }) => {
    await Promise.all([
      checkAchievementsForMetric(userId, "POSTS_CREATED"),
      checkAchievementsForMetric(userId, "REVIEWS_CREATED"),
    ]);
  });
  bus.on("comment_created", ({ userId }) =>
    checkAchievementsForMetric(userId, "COMMENTS_CREATED"),
  );
  bus.on("award_granted", ({ granterId }) =>
    checkAchievementsForMetric(granterId, "AWARDS_GRANTED"),
  );
}
