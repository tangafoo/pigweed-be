import { Hono } from "hono";
import { prisma } from "../utils/db";
import { requireSignIn, type AuthVars } from "../middleware/require-sign-in";
import { getActivePlansWithBenefits, computeStats } from "../utils/subscriptions";

// ─────────────────────────────────────────────────────────────
// EGG SUBSCRIPTIONS (public, read-only). Three tiers (120/60/30
// eggs at RM2/egg) + a shared benefit list power the subscribe page;
// the actual subscribe action is MANUAL — the FE points the customer
// at a WhatsApp link, payment happens off-platform, and the admin
// flips them on from the panel. Phase 2 adds Stripe self-checkout.
// ─────────────────────────────────────────────────────────────

export const subscriptions = new Hono<AuthVars>();

// Public: the tiers, each with its own benefit checklist, for the subscribe page.
subscriptions.get("/plans", async (c) => {
  const plans = await getActivePlansWithBenefits();
  return c.json({ plans });
});

// The signed-in user's subscription + fun egg stats (or nulls if none).
subscriptions.get("/me", requireSignIn, async (c) => {
  const userId = c.get("userId");

  const sub = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  });

  if (!sub) return c.json({ subscription: null, stats: null });

  // STRIPE delivery count is exact (phase 2); 0 under manual billing.
  const stripePaymentsCount = await prisma.subscriptionPayment.count({
    where: { subscriptionId: sub.id, mode: "STRIPE" },
  });

  const stats = computeStats({
    startedAt: sub.startedAt,
    canceledAt: sub.canceledAt,
    status: sub.status,
    billingMode: sub.billingMode,
    eggsPerDelivery: sub.plan.eggsPerDelivery,
    cadenceWeeks: sub.plan.cadenceWeeks,
    stripePaymentsCount,
  });

  return c.json({
    subscription: {
      status: sub.status,
      billingMode: sub.billingMode,
      startedAt: sub.startedAt.toISOString(),
      deliveryDay: sub.deliveryDay,
      currentPeriodEnd: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
      plan: {
        id: sub.plan.id,
        name: sub.plan.name,
        eggsPerDelivery: sub.plan.eggsPerDelivery,
        priceCents: sub.plan.priceCents,
        currency: sub.plan.currency,
        cadenceWeeks: sub.plan.cadenceWeeks,
      },
    },
    stats,
  });
});
