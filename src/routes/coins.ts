import { Hono } from "hono";
import { prisma } from "../utils/db";
import { stripe } from "../utils/stripe";
import { requireSignIn, type AuthVars } from "../middleware/require-sign-in";

export const coins = new Hono<AuthVars>();

coins.get("/packs", async (c) => {
  const packs = await prisma.coinPack.findMany({
    where: { active: true },
    orderBy: { priceCents: "asc" },
    select: { id: true, name: true, coins: true, priceCents: true, currency: true },
  });
  return c.json({ packs });
});

coins.get("/balance", requireSignIn, async (c) => {
  const userId = c.get("userId");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { coinBalance: true },
  });
  return c.json({ balance: user?.coinBalance ?? 0 });
});

coins.post("/checkout", requireSignIn, async (c) => {
  const userId = c.get("userId");

  const body = await c.req.json().catch(() => null);
  const coinPackId = body?.coinPackId;
  if (typeof coinPackId !== "string") {
    return c.json({ error: "coinPackId is required" }, 400);
  }

  const pack = await prisma.coinPack.findUnique({ where: { id: coinPackId } });
  if (!pack || !pack.active) return c.json({ error: "pack not found" }, 404);

  const purchase = await prisma.coinPurchase.create({
    data: {
      userId,
      coinPackId: pack.id,
      stripeSessionId: `pending_${crypto.randomUUID()}`,
      coinsGranted: pack.coins,
      amountCents: pack.priceCents,
      currency: pack.currency,
      status: "pending",
    },
  });

  const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const checkout = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: pack.stripePriceId, quantity: 1 }],
    success_url: `${baseUrl}/coins/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/coins/cancel`,
    client_reference_id: purchase.id,
    metadata: { purchaseId: purchase.id, userId },
  });

  await prisma.coinPurchase.update({
    where: { id: purchase.id },
    data: { stripeSessionId: checkout.id },
  });

  return c.json({ url: checkout.url, purchaseId: purchase.id });
});

coins.get("/success", (c) => c.text("Payment complete. You can close this tab."));
coins.get("/cancel", (c) => c.text("Payment cancelled."));
