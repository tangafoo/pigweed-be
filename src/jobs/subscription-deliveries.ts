// ─────────────────────────────────────────────────────────────
// SUBSCRIPTION DELIVERY CRON — standalone script for its OWN Railway
// Cron service (NOT mixed with jobs:digest). Each ACTIVE subscription
// "fires" an egg order on its delivery weekday, every `cadenceWeeks`,
// until it's paused/canceled. Idempotent: re-runs on the same day
// won't double-record.
//
// Run locally:  bun run jobs:subscription-deliveries
// Railway:      a SEPARATE Cron service, start command
//               `bun run jobs:subscription-deliveries`, schedule e.g.
//               `0 6 * * *` (daily 06:00 UTC — it self-filters to the
//               right weekday/cadence).
// ─────────────────────────────────────────────────────────────

import { prisma } from "../utils/db";
import { makeId, ID_PREFIX } from "../utils/ids";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

async function run(): Promise<void> {
  const now = new Date();
  console.log(`[sub-deliveries] run started ${now.toISOString()}`);

  const subs = await prisma.subscription.findMany({
    where: { status: "ACTIVE" }, // paused/canceled subs don't fire
    include: { plan: true },
  });

  const today = startOfDay(now);
  const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const weekday = now.getDay();

  let fired = 0;
  let skipped = 0;

  for (const sub of subs) {
    // Right weekday?
    if (sub.deliveryDay !== weekday) continue;
    // Not before it started?
    if (today < startOfDay(sub.startedAt)) continue;
    // Due this week per cadence (aligned to the start week)?
    const weeksSince = Math.floor((today.getTime() - startOfDay(sub.startedAt).getTime()) / WEEK_MS);
    if (weeksSince % Math.max(1, sub.plan.cadenceWeeks) !== 0) continue;

    // Idempotent: already fired a subscription order today?
    const existing = await prisma.eggOrder.findFirst({
      where: {
        userId: sub.userId,
        source: "SUBSCRIPTION",
        orderedAt: { gte: today, lt: tomorrow },
      },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    await prisma.eggOrder.create({
      data: {
        id: makeId(ID_PREFIX.EGG_ORDER),
        userId: sub.userId,
        eggs: sub.plan.eggsPerDelivery,
        orderedAt: now,
        source: "SUBSCRIPTION",
      },
    });
    fired++;
  }

  console.log(
    `[sub-deliveries] done — ${fired} fired, ${skipped} already-recorded, ${subs.length} active subs checked`,
  );
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[sub-deliveries] fatal:", err);
    process.exit(1);
  });
