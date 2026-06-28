import { prisma } from "./db";
import { stripe } from "./stripe";
import { makeId, ID_PREFIX } from "./ids";
import type { SubscriptionStatus } from "../generated/prisma/client";

// ─────────────────────────────────────────────────────────────
// SUBSCRIPTION HELPERS — shared by the /subscriptions route, the
// /admin route, and the CLI scripts. Payments are MANUAL today
// (collected off-platform via WhatsApp/bank transfer); the Stripe
// helpers here are dormant wiring for phase 2 (auto-billing once the
// farm scales past ~100 subscribers).
// ─────────────────────────────────────────────────────────────

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type PlanRow = {
  id: string;
  name: string;
  eggsPerDelivery: number;
  priceCents: number;
  currency: string;
  cadenceWeeks: number;
};

const PLAN_SELECT = {
  id: true,
  name: true,
  eggsPerDelivery: true,
  priceCents: true,
  currency: true,
  cadenceWeeks: true,
} as const;

export type BenefitRow = { id: string; label: string; sortOrder: number };
export type PlanWithBenefits = PlanRow & { benefits: BenefitRow[] };

// The active tiers (by sortOrder), each with its own checked benefit list
// (active benefits only, ordered). Powers GET /subscriptions/plans.
export async function getActivePlansWithBenefits(): Promise<PlanWithBenefits[]> {
  const plans = await prisma.subscriptionPlan.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
    select: {
      ...PLAN_SELECT,
      benefits: {
        select: { benefit: { select: { id: true, label: true, sortOrder: true, active: true } } },
      },
    },
  });
  return plans.map(({ benefits, ...plan }) => ({
    ...plan,
    benefits: benefits
      .map((b) => b.benefit)
      .filter((b) => b.active)
      .sort((a, z) => a.sortOrder - z.sortOrder)
      .map(({ id, label, sortOrder }) => ({ id, label, sortOrder })),
  }));
}

// Replace a tier's checked benefit set (the admin checklist save). Deletes the
// old links and inserts the new ones in one transaction.
export async function setPlanBenefits(planId: string, benefitIds: string[]): Promise<void> {
  const unique = [...new Set(benefitIds)];
  await prisma.$transaction([
    prisma.planBenefit.deleteMany({ where: { planId } }),
    prisma.planBenefit.createMany({
      data: unique.map((benefitId) => ({ planId, benefitId })),
      skipDuplicates: true,
    }),
  ]);
}

export async function getPlanById(id: string): Promise<PlanRow | null> {
  return prisma.subscriptionPlan.findUnique({ where: { id }, select: PLAN_SELECT });
}

// Convenience for the CLI: pick the active tier by its egg count (30/60/120).
export async function getPlanByEggs(eggs: number): Promise<PlanRow | null> {
  return prisma.subscriptionPlan.findFirst({
    where: { active: true, eggsPerDelivery: eggs },
    select: PLAN_SELECT,
  });
}

// Activate (or re-activate) a user's manual subscription on a tier. One row
// per user — upserted. `startedAt` lets an admin backfill a historical start
// date; `deliveryDay` (0=Sun…6=Sat) sets the weekly delivery weekday. Used by
// the admin API and the CLI scripts.
export async function subscribeUser(
  userId: string,
  planId: string,
  opts: { startedAt?: Date; deliveryDay?: number } = {},
) {
  return prisma.subscription.upsert({
    where: { userId },
    create: {
      id: makeId(ID_PREFIX.SUBSCRIPTION),
      userId,
      planId,
      status: "ACTIVE",
      billingMode: "MANUAL",
      ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
      ...(opts.deliveryDay !== undefined ? { deliveryDay: opts.deliveryDay } : {}),
    },
    update: {
      planId,
      status: "ACTIVE",
      billingMode: "MANUAL",
      canceledAt: null,
      ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
      ...(opts.deliveryDay !== undefined ? { deliveryDay: opts.deliveryDay } : {}),
    },
  });
}

// Flip a subscription's status (PAUSED / CANCELED / ACTIVE). Stamps canceledAt
// when canceling, clears it otherwise.
export async function setSubscriptionStatus(userId: string, status: SubscriptionStatus) {
  return prisma.subscription.update({
    where: { userId },
    data: {
      status,
      canceledAt: status === "CANCELED" ? new Date() : null,
    },
  });
}

// Fun "you've eaten N eggs" numbers. Today MANUAL deliveries are estimated
// from weeks elapsed ÷ plan cadence (no per-delivery row exists) plus the
// current in-progress period while active. Phase-2 STRIPE deliveries are
// exact (one paid invoice = one delivery). `canceledAt` clamps the window.
export function computeStats(args: {
  startedAt: Date;
  canceledAt: Date | null;
  status: string;
  billingMode: "STRIPE" | "MANUAL";
  eggsPerDelivery: number;
  cadenceWeeks: number;
  stripePaymentsCount: number;
}): { weeksActive: number; totalDeliveries: number; totalEggs: number } {
  const end = args.canceledAt ?? new Date();
  const weeksActive = Math.max(0, Math.floor((end.getTime() - args.startedAt.getTime()) / WEEK_MS));

  const cadence = Math.max(1, args.cadenceWeeks);
  const totalDeliveries =
    args.billingMode === "STRIPE"
      ? args.stripePaymentsCount
      : Math.floor(weeksActive / cadence) + (args.status === "ACTIVE" ? 1 : 0);

  return {
    weeksActive,
    totalDeliveries,
    totalEggs: totalDeliveries * args.eggsPerDelivery,
  };
}

// "RM50/week"-style label. Special-cases MYR → "RM". Kept for phase-2 Stripe
// price display + any server-side formatting.
export function formatPrice(priceCents: number, currency: string, cadenceWeeks: number): string {
  const amount = priceCents / 100;
  const pretty = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const unit = currency.toLowerCase() === "myr" ? `RM${pretty}` : `${currency.toUpperCase()} ${pretty}`;
  const period = cadenceWeeks === 1 ? "week" : `${cadenceWeeks} weeks`;
  return `${unit}/${period}`;
}

// ─── (phase 2) Stripe ──────────────────────────────────────────────
// Lazily create + cache the Stripe customer for a user (coins and future
// subscriptions share one). Dormant until auto-billing is switched on.
export async function ensureStripeCustomer(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true, email: true, username: true },
  });
  if (!user) throw new Error(`user ${userId} not found`);
  if (user.stripeCustomerId) return user.stripeCustomerId;

  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { userId, username: user.username },
  });
  await prisma.user.update({ where: { id: userId }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}
