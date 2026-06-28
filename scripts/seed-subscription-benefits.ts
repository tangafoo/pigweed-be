import { prisma } from "../src/utils/db";

// Seeds the default subscriber benefit list. These are EDITABLE from the admin
// panel (CRUD /admin/benefits) afterwards — this just gives a sensible starting
// set. Idempotent: upserts on a stable id, so re-running won't duplicate.

const BENEFITS: string[] = [
  "Guaranteed weekly eggs",
  "Priority allocation during limited supply",
  "Reserved delivery slot",
  "Flexible pause anytime",
  "Subscriber-only pricing on seasonal orchard harvests",
  "First access to durian and other farm produce",
  "Complimentary farm surprises throughout the year",
];

async function main() {
  for (let i = 0; i < BENEFITS.length; i++) {
    const id = `subben_${i}`; // stable id → idempotent upsert
    const label = BENEFITS[i];
    await prisma.subscriptionBenefit.upsert({
      where: { id },
      create: { id, label, sortOrder: i, active: true },
      update: { label, sortOrder: i, active: true },
    });
    console.log(`  ${String(i).padStart(2)}  ${label}`);
  }

  // Default per-tier checklist: link every active benefit to every active tier
  // (all-to-all). The admin curates each tier from the panel afterwards.
  // Idempotent via skipDuplicates. Requires plans to be seeded first (seed:all
  // runs plans before benefits).
  const plans = await prisma.subscriptionPlan.findMany({ where: { active: true }, select: { id: true } });
  const benefitIds = (
    await prisma.subscriptionBenefit.findMany({ where: { active: true }, select: { id: true } })
  ).map((b) => b.id);
  for (const plan of plans) {
    await prisma.planBenefit.createMany({
      data: benefitIds.map((benefitId) => ({ planId: plan.id, benefitId })),
      skipDuplicates: true,
    });
  }
  console.log(`Linked ${benefitIds.length} benefits to ${plans.length} tiers (all-to-all default).`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
