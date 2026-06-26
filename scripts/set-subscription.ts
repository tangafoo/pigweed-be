import { prisma } from "../src/utils/db";
import { getPlanByEggs, subscribeUser, setSubscriptionStatus } from "../src/utils/subscriptions";

// ─────────────────────────────────────────────────────────────
// SET A USER'S SUBSCRIPTION (manual) — subscribe an existing user to
// a tier, or cancel. Same effect as the admin-panel subscribe toggle.
// Payments are manual (collected off-platform via WhatsApp/transfer);
// this just records the subscription so the FE/admin reflect it.
//
// Usage:
//   bun run subscriber:subscribe <email> <30|60|120>   # subscribe to a tier
//   bun run subscriber:subscribe <email> --cancel       # cancel
// ─────────────────────────────────────────────────────────────

const TIER_EGGS = [30, 60, 120];

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const arg = process.argv[3]?.trim();
  const cancel = process.argv.includes("--cancel");

  if (!email || !email.includes("@")) {
    console.error("Usage: bun run subscriber:subscribe <email> <30|60|120> | --cancel");
    process.exit(1);
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, username: true },
  });
  if (!user) {
    console.error(`No user with email ${email}. Run subscriber:register first.`);
    process.exit(1);
  }

  if (cancel) {
    const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
    if (!sub) {
      console.log(`${user.username} has no subscription — nothing to cancel.`);
      return;
    }
    await setSubscriptionStatus(user.id, "CANCELED");
    console.log(`Canceled ${user.username}'s subscription.`);
    return;
  }

  const eggs = Number(arg);
  if (!TIER_EGGS.includes(eggs)) {
    console.error(`Pick a tier: ${TIER_EGGS.join(" | ")} (or --cancel).`);
    process.exit(1);
  }

  const plan = await getPlanByEggs(eggs);
  if (!plan) {
    console.error(`No active ${eggs}-egg plan — run \`bun run seed:subscriptions\` first.`);
    process.exit(1);
  }

  await subscribeUser(user.id, plan.id);
  console.log(
    `${user.username} <${email}> is now an ACTIVE subscriber on the ${eggs}-egg tier (RM${(plan.priceCents / 100).toFixed(2)}/${plan.cadenceWeeks === 1 ? "week" : plan.cadenceWeeks + " weeks"}, MANUAL).`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
