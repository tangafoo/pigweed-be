import { Hono } from "hono";
import type Stripe from "stripe";
import { prisma } from "../utils/db";
import { stripe, stripeWebhookSecret } from "../utils/stripe";

export const stripeWebhook = new Hono();

stripeWebhook.post("/", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature) return c.json({ error: "missing signature" }, 400);

  const rawBody = await c.req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, stripeWebhookSecret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid signature";
    console.error("[stripe-webhook] verification failed:", message);
    return c.json({ error: message }, 400);
  }

  if (event.type === "checkout.session.completed") {
    await handleCheckoutCompleted(event);
  }

  return c.json({ received: true });
});

async function handleCheckoutCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  const purchaseId = session.metadata?.purchaseId;
  if (!purchaseId) return;
  if (session.payment_status !== "paid") return;

  const alreadyProcessed = await prisma.coinPurchase.findFirst({
    where: { stripeEventId: event.id },
    select: { id: true },
  });
  if (alreadyProcessed) return;

  await prisma.$transaction(async (tx) => {
    const purchase = await tx.coinPurchase.findUnique({ where: { id: purchaseId } });
    if (!purchase) return;
    if (purchase.status === "completed") return;

    await tx.coinPurchase.update({
      where: { id: purchase.id },
      data: {
        status: "completed",
        stripeEventId: event.id,
        completedAt: new Date(),
      },
    });

    await tx.user.update({
      where: { id: purchase.userId },
      data: { coinBalance: { increment: purchase.coinsGranted } },
    });
  });
}
