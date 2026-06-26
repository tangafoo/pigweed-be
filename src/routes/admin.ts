import { Hono } from "hono";
import { prisma } from "../utils/db";
import { makeId, ID_PREFIX } from "../utils/ids";
import { requireAdmin, type AdminVars } from "../middleware/require-admin";
import { subscribeUser, setSubscriptionStatus, setPlanBenefits } from "../utils/subscriptions";
import { grantAchievementByKey } from "../utils/achievements";

// ─────────────────────────────────────────────────────────────
// ADMIN PANEL API — gated by requireAdmin (User.isAdmin). Backs the
// boss's panel: see all users (with post/review/comment counts +
// email + subscription), subscribe/unsubscribe/pause them (manual
// billing), toggle flairs (founding flock / OP), and CRUD the
// benefit list. The start of the farm's CRM.
// ─────────────────────────────────────────────────────────────

export const admin = new Hono<AdminVars>();
admin.use("*", requireAdmin);

const FOUNDING_FLOCK_KEY = "founding_flock";

// Shape a Subscription (with its plan) into the wire SubscriptionSummary.
function subSummary(sub: {
  status: string;
  billingMode: string;
  startedAt: Date;
  deliveryDay: number;
  currentPeriodEnd: Date | null;
  plan: { id: string; name: string; eggsPerDelivery: number; priceCents: number; currency: string; cadenceWeeks: number };
} | null) {
  if (!sub) return null;
  return {
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
  };
}

// ─── Users table ───────────────────────────────────────────────────
admin.get("/users", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const q = c.req.query("q")?.trim();

  const where = q
    ? {
        OR: [
          { username: { contains: q, mode: "insensitive" as const } },
          { email: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        username: true,
        email: true,
        gender: true,
        animal: true,
        avatarSeed: true,
        isFarmOwner: true,
        isFoundingFlock: true,
        isAdmin: true,
        createdAt: true,
        subscription: { include: { plan: true } },
      },
    }),
  ]);

  // Counts via groupBy (reliable across Prisma versions, one query each).
  const ids = users.map((u) => u.id);
  const [postCounts, reviewCounts, commentCounts] = await Promise.all([
    prisma.post.groupBy({ by: ["authorId"], where: { authorId: { in: ids }, deletedAt: null }, _count: true }),
    prisma.post.groupBy({ by: ["authorId"], where: { authorId: { in: ids }, deletedAt: null, rating: { not: null } }, _count: true }),
    prisma.comment.groupBy({ by: ["authorId"], where: { authorId: { in: ids }, deletedAt: null }, _count: true }),
  ]);
  const postMap = new Map(postCounts.map((r) => [r.authorId, r._count]));
  const reviewMap = new Map(reviewCounts.map((r) => [r.authorId, r._count]));
  const commentMap = new Map(commentCounts.map((r) => [r.authorId, r._count]));

  return c.json({
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      gender: u.gender,
      animal: u.animal,
      avatarSeed: u.avatarSeed,
      isFarmOwner: u.isFarmOwner,
      isFoundingFlock: u.isFoundingFlock,
      isAdmin: u.isAdmin,
      createdAt: u.createdAt.toISOString(),
      postCount: postMap.get(u.id) ?? 0,
      reviewCount: reviewMap.get(u.id) ?? 0,
      commentCount: commentMap.get(u.id) ?? 0,
      subscription: subSummary(u.subscription),
    })),
    page,
    limit,
    total,
  });
});

// ─── Subscription actions (manual billing) ─────────────────────────
admin.post("/users/:id/subscribe", async (c) => {
  const userId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const planId = body?.planId;
  if (typeof planId !== "string") return c.json({ error: "planId is required" }, 400);

  // Optional backfill start date + weekly delivery day (0=Sun…6=Sat).
  let startedAt: Date | undefined;
  if (typeof body?.startedAt === "string") {
    const d = new Date(body.startedAt);
    if (!Number.isNaN(d.getTime())) startedAt = d;
  }
  const deliveryDay =
    typeof body?.deliveryDay === "number" && body.deliveryDay >= 0 && body.deliveryDay <= 6
      ? body.deliveryDay
      : undefined;

  const [user, plan] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
    prisma.subscriptionPlan.findUnique({ where: { id: planId }, select: { id: true, active: true } }),
  ]);
  if (!user) return c.json({ error: "user not found" }, 404);
  if (!plan || !plan.active) return c.json({ error: "plan not found" }, 404);

  await subscribeUser(userId, planId, { startedAt, deliveryDay });
  const sub = await prisma.subscription.findUnique({ where: { userId }, include: { plan: true } });
  console.log(`[admin] subscribed ${userId} → plan ${planId}${startedAt ? ` from ${startedAt.toISOString()}` : ""}`);
  return c.json({ subscription: subSummary(sub) });
});

admin.post("/users/:id/unsubscribe", async (c) => {
  const userId = c.req.param("id");
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub) return c.json({ error: "no subscription" }, 404);
  await setSubscriptionStatus(userId, "CANCELED");
  console.log(`[admin] unsubscribed ${userId}`);
  return c.json({ ok: true });
});

admin.post("/users/:id/pause", async (c) => {
  const userId = c.req.param("id");
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub) return c.json({ error: "no subscription" }, 404);
  await setSubscriptionStatus(userId, "PAUSED");
  return c.json({ ok: true });
});

admin.post("/users/:id/resume", async (c) => {
  const userId = c.req.param("id");
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub) return c.json({ error: "no subscription" }, 404);
  await setSubscriptionStatus(userId, "ACTIVE");
  return c.json({ ok: true });
});

// ─── Flairs / roles ────────────────────────────────────────────────
admin.patch("/users/:id/flags", async (c) => {
  const userId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);

  const data: { isFoundingFlock?: boolean; isFarmOwner?: boolean; isAdmin?: boolean } = {};
  if (typeof body.isFoundingFlock === "boolean") data.isFoundingFlock = body.isFoundingFlock;
  if (typeof body.isFarmOwner === "boolean") data.isFarmOwner = body.isFarmOwner;
  if (typeof body.isAdmin === "boolean") data.isAdmin = body.isAdmin;
  if (Object.keys(data).length === 0) return c.json({ error: "provide at least one flag" }, 400);

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return c.json({ error: "user not found" }, 404);

  await prisma.user.update({ where: { id: userId }, data });

  // Turning founding flock ON also grants the (silent) Founding Flock
  // achievement. Turning it off leaves the achievement history intact.
  if (data.isFoundingFlock === true) {
    await grantAchievementByKey(userId, FOUNDING_FLOCK_KEY);
  }

  console.log(`[admin] flags for ${userId}: ${JSON.stringify(data)}`);
  return c.json({ ok: true, ...data });
});

// ─── Benefits CRUD ─────────────────────────────────────────────────
admin.get("/benefits", async (c) => {
  const benefits = await prisma.subscriptionBenefit.findMany({
    orderBy: { sortOrder: "asc" },
    select: { id: true, label: true, sortOrder: true, active: true },
  });
  return c.json({ benefits });
});

admin.post("/benefits", async (c) => {
  const body = await c.req.json().catch(() => null);
  const label = body?.label;
  if (typeof label !== "string" || label.trim().length === 0) {
    return c.json({ error: "label is required" }, 400);
  }
  const benefit = await prisma.subscriptionBenefit.create({
    data: {
      id: makeId(ID_PREFIX.SUBSCRIPTION_BENEFIT),
      label: label.trim(),
      sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : 0,
      active: typeof body.active === "boolean" ? body.active : true,
    },
    select: { id: true, label: true, sortOrder: true, active: true },
  });
  return c.json({ benefit }, 201);
});

admin.patch("/benefits/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);

  const data: { label?: string; sortOrder?: number; active?: boolean } = {};
  if (typeof body.label === "string" && body.label.trim()) data.label = body.label.trim();
  if (typeof body.sortOrder === "number") data.sortOrder = body.sortOrder;
  if (typeof body.active === "boolean") data.active = body.active;
  if (Object.keys(data).length === 0) return c.json({ error: "nothing to update" }, 400);

  const existing = await prisma.subscriptionBenefit.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return c.json({ error: "benefit not found" }, 404);

  const benefit = await prisma.subscriptionBenefit.update({
    where: { id },
    data,
    select: { id: true, label: true, sortOrder: true, active: true },
  });
  return c.json({ benefit });
});

admin.delete("/benefits/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await prisma.subscriptionBenefit.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return c.json({ error: "benefit not found" }, 404);
  await prisma.subscriptionBenefit.delete({ where: { id } });
  return c.json({ ok: true });
});

// ─── Tier benefit checklists ───────────────────────────────────────
// GET returns every tier with the ids of its checked benefits; the panel
// renders the full /admin/benefits catalog as checkboxes against these.
admin.get("/plans", async (c) => {
  const plans = await prisma.subscriptionPlan.findMany({
    orderBy: { sortOrder: "asc" },
    select: {
      id: true,
      name: true,
      eggsPerDelivery: true,
      priceCents: true,
      currency: true,
      cadenceWeeks: true,
      active: true,
      benefits: { select: { benefitId: true } },
    },
  });
  return c.json({
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      eggsPerDelivery: p.eggsPerDelivery,
      priceCents: p.priceCents,
      currency: p.currency,
      cadenceWeeks: p.cadenceWeeks,
      active: p.active,
      benefitIds: p.benefits.map((b) => b.benefitId),
    })),
  });
});

// Replace a tier's checked benefit set (the checklist save).
admin.put("/plans/:planId/benefits", async (c) => {
  const planId = c.req.param("planId");
  const body = await c.req.json().catch(() => null);
  const benefitIds = body?.benefitIds;
  if (!Array.isArray(benefitIds) || !benefitIds.every((x) => typeof x === "string")) {
    return c.json({ error: "benefitIds (string[]) is required" }, 400);
  }

  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId }, select: { id: true } });
  if (!plan) return c.json({ error: "plan not found" }, 404);

  // Drop unknown ids defensively (stale FE state); only link real benefits.
  const valid = await prisma.subscriptionBenefit.findMany({
    where: { id: { in: benefitIds } },
    select: { id: true },
  });
  const validIds = valid.map((b) => b.id);
  await setPlanBenefits(planId, validIds);
  console.log(`[admin] set ${validIds.length} benefits on plan ${planId}`);
  return c.json({ ok: true, benefitIds: validIds });
});

// ─── Dashboard stats ───────────────────────────────────────────────
admin.get("/stats", async (c) => {
  const [totalUsers, activeSubscribers, totalPosts, totalReviews] = await Promise.all([
    prisma.user.count(),
    prisma.subscription.count({ where: { status: "ACTIVE" } }),
    prisma.post.count({ where: { deletedAt: null } }),
    prisma.post.count({ where: { deletedAt: null, rating: { not: null } } }),
  ]);
  return c.json({ totalUsers, activeSubscribers, totalPosts, totalReviews });
});
