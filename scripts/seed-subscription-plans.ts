import { prisma } from "../src/utils/db";

// Seeds the three egg-subscription tiers. Price is RM2/egg, so priceCents is
// derived (eggs × 200). No Stripe price is created — billing is manual today
// (phase 2 will backfill stripePriceId). Idempotent: upserts on a stable id.

type TierSeed = {
  eggs: number;
  cadenceWeeks: number;
  sortOrder: number;
  name: string;
};

const PRICE_PER_EGG_CENTS = 200; // RM2.00

const TIERS: TierSeed[] = [
  { eggs: 120, cadenceWeeks: 1, sortOrder: 0, name: "120 Eggs / week" },
  { eggs: 60, cadenceWeeks: 1, sortOrder: 1, name: "60 Eggs / week" },
  { eggs: 30, cadenceWeeks: 2, sortOrder: 2, name: "30 Eggs / fortnight" },
];

async function main() {
  for (const t of TIERS) {
    const id = `subplan_eggs${t.eggs}`; // stable id → idempotent upsert
    const priceCents = t.eggs * PRICE_PER_EGG_CENTS;

    await prisma.subscriptionPlan.upsert({
      where: { id },
      create: {
        id,
        name: t.name,
        priceCents,
        currency: "myr",
        eggsPerDelivery: t.eggs,
        cadenceWeeks: t.cadenceWeeks,
        sortOrder: t.sortOrder,
        active: true,
      },
      update: {
        name: t.name,
        priceCents,
        eggsPerDelivery: t.eggs,
        cadenceWeeks: t.cadenceWeeks,
        sortOrder: t.sortOrder,
        active: true,
      },
    });

    const period = t.cadenceWeeks === 1 ? "week" : `${t.cadenceWeeks} weeks`;
    console.log(`  ${t.name.padEnd(22)} ${t.eggs} eggs  RM${(priceCents / 100).toFixed(2)}/${period}`);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
