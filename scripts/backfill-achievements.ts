import { prisma } from "../src/utils/db";
import { evaluateMetric, grantAchievement } from "../src/utils/achievements";

// ─────────────────────────────────────────────────────────────
// ONE-OFF BACKFILL (re-runnable) — grant every active achievement to every
// user who already qualifies but doesn't have it yet. Run after adding a new
// achievement (e.g. First Review) so existing users get what they've earned.
//
//   bun run backfill:achievements
//
// SILENT by design: unlike the live engine, this sends NO emails and emits NO
// SSE — we don't want to blast every existing user with a pile of "unlocked!"
// mail. It reuses the engine's evaluateMetric + grantAchievement, so the rules
// can't drift, and grantAchievement skips already-granted rows (P2002) →
// idempotent, never double-credits.
// ─────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const [users, catalog] = await Promise.all([
    prisma.user.findMany({ select: { id: true } }),
    prisma.achievement.findMany({
      where: { active: true },
      select: { id: true, key: true, name: true, metric: true, threshold: true, rewardCoins: true },
    }),
  ]);

  console.log(`[backfill] ${users.length} user(s) × ${catalog.length} achievement(s)`);

  let granted = 0;
  for (const u of users) {
    for (const a of catalog) {
      const value = await evaluateMetric(u.id, a.metric);
      if (value < a.threshold) continue;
      const res = await grantAchievement(u.id, a);
      if (res) {
        granted++;
        console.log(`[backfill] "${a.name}" (${a.key}) → ${u.id}  +${a.rewardCoins} coins`);
      }
    }
  }

  console.log(`[backfill] done — ${granted} new grant(s)`);
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exit(1);
  });
