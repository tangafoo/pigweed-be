import { Hono } from "hono";
import { prisma } from "../utils/db";
import { makeId, ID_PREFIX } from "../utils/ids";
import { requireAdmin, type AdminVars } from "../middleware/require-admin";
import { subscribeUser, setSubscriptionStatus, setPlanBenefits } from "../utils/subscriptions";
import { grantAchievementByKey } from "../utils/achievements";
import { registerUserByEmail, previewIdentity } from "../utils/onboarding";

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
  // Filter to users who ordered on a given calendar day (UTC). Range is an easy
  // future extension: add ?from / ?to and widen the bounds below.
  const orderedOn = c.req.query("orderedOn");

  const where: Record<string, unknown> = {};
  if (q) {
    where.OR = [
      { username: { contains: q, mode: "insensitive" as const } },
      { email: { contains: q, mode: "insensitive" as const } },
    ];
  }
  if (orderedOn) {
    const start = new Date(`${orderedOn}T00:00:00.000Z`);
    if (!Number.isNaN(start.getTime())) {
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      where.eggOrders = { some: { orderedAt: { gte: start, lt: end } } };
    }
  }

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
        phoneNumber: true,
        gender: true,
        animal: true,
        avatarSeed: true,
        isFarmOwner: true,
        isFoundingFlock: true,
        isAdmin: true,
        coinBalance: true,
        createdAt: true,
        subscription: { include: { plan: true } },
      },
    }),
  ]);

  // Counts via groupBy (reliable across Prisma versions, one query each).
  const ids = users.map((u) => u.id);
  const [postCounts, reviewCounts, commentCounts, orderAgg] = await Promise.all([
    prisma.post.groupBy({ by: ["authorId"], where: { authorId: { in: ids }, deletedAt: null }, _count: true }),
    prisma.post.groupBy({ by: ["authorId"], where: { authorId: { in: ids }, deletedAt: null, rating: { not: null } }, _count: true }),
    prisma.comment.groupBy({ by: ["authorId"], where: { authorId: { in: ids }, deletedAt: null }, _count: true }),
    // eggsEaten + lastOrderAt are derived from the order ledger (SUM / MAX).
    prisma.eggOrder.groupBy({ by: ["userId"], where: { userId: { in: ids } }, _sum: { eggs: true }, _max: { orderedAt: true } }),
  ]);
  const postMap = new Map(postCounts.map((r) => [r.authorId, r._count]));
  const reviewMap = new Map(reviewCounts.map((r) => [r.authorId, r._count]));
  const commentMap = new Map(commentCounts.map((r) => [r.authorId, r._count]));
  const eggsMap = new Map(orderAgg.map((r) => [r.userId, r._sum.eggs ?? 0]));
  const lastOrderMap = new Map(orderAgg.map((r) => [r.userId, r._max.orderedAt]));

  return c.json({
    users: users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      phoneNumber: u.phoneNumber,
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
      coinBalance: u.coinBalance,
      eggsEaten: eggsMap.get(u.id) ?? 0,
      lastOrderAt: lastOrderMap.get(u.id)?.toISOString() ?? null,
      subscription: subSummary(u.subscription),
    })),
    page,
    limit,
    total,
  });
});

// ─── Subscription actions (manual billing) ─────────────────────────
// Preview a generatable identity (unique username + random animal) for the
// "Add user" modal's reroll button — nothing is created.
admin.post("/users/preview", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email : undefined;
  return c.json(await previewIdentity(email));
});

// Pre-register a user from just an email and send them a magic-link login
// (the email greets them with their generated username + animal).
admin.post("/users", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = body?.email;
  if (typeof email !== "string" || !email.includes("@")) {
    return c.json({ error: "a valid email is required" }, 400);
  }
  try {
    const result = await registerUserByEmail({
      email,
      username: typeof body?.username === "string" ? body.username : undefined,
      gender: typeof body?.gender === "string" ? body.gender : undefined,
      animal: typeof body?.animal === "string" ? body.animal : undefined,
    });
    return c.json(result, result.existed ? 200 : 201);
  } catch (err) {
    console.error("[admin] register failed:", err);
    return c.json({ error: "Could not register that user — please try again." }, 500);
  }
});

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

// ─── Egg order ledger (manual records) ─────────────────────────────
// A user's full order history, newest first (powers the expand card).
admin.get("/users/:id/orders", async (c) => {
  const userId = c.req.param("id");
  const orders = await prisma.eggOrder.findMany({
    where: { userId },
    orderBy: { orderedAt: "desc" },
    select: { id: true, eggs: true, orderedAt: true, source: true },
  });
  return c.json({
    orders: orders.map((o) => ({
      id: o.id,
      eggs: o.eggs,
      orderedAt: o.orderedAt.toISOString(),
      source: o.source,
    })),
  });
});

// Add one manual order record ("Jessica · 50 eggs · 16 Jun").
admin.post("/users/:id/orders", async (c) => {
  const userId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const eggs = body?.eggs;
  if (typeof eggs !== "number" || eggs <= 0) return c.json({ error: "eggs must be > 0" }, 400);

  let orderedAt = new Date();
  if (typeof body?.orderedAt === "string") {
    const d = new Date(body.orderedAt);
    if (!Number.isNaN(d.getTime())) orderedAt = d;
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return c.json({ error: "user not found" }, 404);

  await prisma.eggOrder.create({
    data: { id: makeId(ID_PREFIX.EGG_ORDER), userId, eggs: Math.floor(eggs), orderedAt, source: "MANUAL" },
  });
  console.log(`[admin] order recorded: ${userId} +${eggs} eggs @ ${orderedAt.toISOString()}`);
  return c.json({ ok: true }, 201);
});

// Remove a single order record.
admin.delete("/orders/:orderId", async (c) => {
  const orderId = c.req.param("orderId");
  const existing = await prisma.eggOrder.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!existing) return c.json({ error: "order not found" }, 404);
  await prisma.eggOrder.delete({ where: { id: orderId } });
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

// Hard-delete a user. Every relation off User is onDelete: Cascade in the
// schema (posts → their comments/votes/awards/media, the user's own
// comments/votes/awards, orders, subscription, achievements, sessions,
// accounts, passkeys), so one delete wipes them cleanly. Guards against an
// admin deleting their own account.
admin.delete("/users/:id", async (c) => {
  const userId = c.req.param("id");
  if (userId === c.get("userId")) {
    return c.json({ error: "You can't delete your own account." }, 400);
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return c.json({ error: "user not found" }, 404);

  await prisma.user.delete({ where: { id: userId } });
  console.log(`[admin] deleted user ${userId} (cascade: posts, comments, votes, orders…)`);
  return c.json({ ok: true });
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

// Create a new tier. priceCents defaults to RM2/egg; sortOrder appends.
admin.post("/plans", async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = body?.name;
  const eggs = body?.eggsPerDelivery;
  if (typeof name !== "string" || !name.trim()) return c.json({ error: "name is required" }, 400);
  if (typeof eggs !== "number" || eggs <= 0) return c.json({ error: "eggsPerDelivery must be > 0" }, 400);

  const cadenceWeeks =
    typeof body?.cadenceWeeks === "number" && body.cadenceWeeks >= 1 ? Math.floor(body.cadenceWeeks) : 1;
  const priceCents =
    typeof body?.priceCents === "number" && body.priceCents >= 0
      ? Math.floor(body.priceCents)
      : Math.floor(eggs) * 200; // RM2 / egg
  const sortOrder =
    typeof body?.sortOrder === "number" ? Math.floor(body.sortOrder) : await prisma.subscriptionPlan.count();

  const plan = await prisma.subscriptionPlan.create({
    data: {
      id: makeId(ID_PREFIX.SUBSCRIPTION_PLAN),
      name: name.trim(),
      eggsPerDelivery: Math.floor(eggs),
      cadenceWeeks,
      priceCents,
      currency: "myr",
      sortOrder,
      active: true,
    },
    select: { id: true },
  });
  console.log(`[admin] created plan ${plan.id} (${name.trim()})`);
  return c.json({ id: plan.id }, 201);
});

// Edit a tier's metadata (name / eggs / cadence / price / order / active).
admin.patch("/plans/:planId", async (c) => {
  const planId = c.req.param("planId");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "invalid body" }, 400);

  const data: {
    name?: string;
    eggsPerDelivery?: number;
    cadenceWeeks?: number;
    priceCents?: number;
    sortOrder?: number;
    active?: boolean;
  } = {};
  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
  if (typeof body.eggsPerDelivery === "number" && body.eggsPerDelivery > 0)
    data.eggsPerDelivery = Math.floor(body.eggsPerDelivery);
  if (typeof body.cadenceWeeks === "number" && body.cadenceWeeks >= 1)
    data.cadenceWeeks = Math.floor(body.cadenceWeeks);
  if (typeof body.priceCents === "number" && body.priceCents >= 0)
    data.priceCents = Math.floor(body.priceCents);
  if (typeof body.sortOrder === "number") data.sortOrder = Math.floor(body.sortOrder);
  if (typeof body.active === "boolean") data.active = body.active;
  if (Object.keys(data).length === 0) return c.json({ error: "nothing to update" }, 400);

  const existing = await prisma.subscriptionPlan.findUnique({ where: { id: planId }, select: { id: true } });
  if (!existing) return c.json({ error: "plan not found" }, 404);

  await prisma.subscriptionPlan.update({ where: { id: planId }, data });
  console.log(`[admin] updated plan ${planId}: ${JSON.stringify(data)}`);
  return c.json({ ok: true });
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
  const [totalUsers, activeSubscribers, totalPosts, totalReviews, eggAgg] = await Promise.all([
    prisma.user.count(),
    prisma.subscription.count({ where: { status: "ACTIVE" } }),
    prisma.post.count({ where: { deletedAt: null } }),
    prisma.post.count({ where: { deletedAt: null, rating: { not: null } } }),
    prisma.eggOrder.aggregate({ _sum: { eggs: true } }),
  ]);
  return c.json({
    totalUsers,
    activeSubscribers,
    totalPosts,
    totalReviews,
    totalEggs: eggAgg._sum.eggs ?? 0,
  });
});
