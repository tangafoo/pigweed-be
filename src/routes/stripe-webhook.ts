import { Hono } from "hono";
import type Stripe from "stripe";
import { prisma } from "../utils/db";
import { stripe, stripeWebhookSecret } from "../utils/stripe";
import { makeId, ID_PREFIX } from "../utils/ids";
import { sendEmail } from "../utils/email";
import { appUrl } from "../utils/env";
import { formatPrice } from "../utils/subscriptions";
import {
  subscriptionStartedEmail,
  paymentFailedEmail,
} from "../emails/templates";

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

  switch (event.type) {
    case "checkout.session.completed": {
      // One endpoint, two products. Coins are one-time (mode "payment");
      // egg subs are recurring (mode "subscription"). Branch so they never
      // step on each other.
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "subscription") {
        await handleSubscriptionCheckout(event, session);
      } else {
        await handleCoinCheckoutCompleted(event, session);
      }
      break;
    }
    case "invoice.payment_succeeded":
      await handleInvoicePaid(event);
      break;
    case "invoice.payment_failed":
      await handleInvoiceFailed(event);
      break;
    case "customer.subscription.updated":
      await handleSubscriptionUpdated(event);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(event);
      break;
  }

  return c.json({ received: true });
});

// ─── Coins (unchanged) ─────────────────────────────────────────────
async function handleCoinCheckoutCompleted(event: Stripe.Event, session: Stripe.Checkout.Session) {
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

    console.log(
      `[stripe-webhook] credited ${purchase.coinsGranted} coins to ${purchase.userId} (purchase ${purchase.id}, evt ${event.id})`,
    );
  });
}

// ─── Egg subscriptions ─────────────────────────────────────────────

// Stripe field locations drift by pinned API version (e.g. invoice.subscription
// moved under invoice.parent.subscription_details; period end moved onto sub
// items). Webhooks deliver whatever the account's version sends, so we read
// these defensively rather than trusting one type shape.

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const anyInv = invoice as any;
  const fromTop = anyInv.subscription;
  if (typeof fromTop === "string") return fromTop;
  const fromParent = anyInv.parent?.subscription_details?.subscription;
  if (typeof fromParent === "string") return fromParent;
  const fromLine = anyInv.lines?.data?.[0]?.subscription;
  return typeof fromLine === "string" ? fromLine : null;
}

function invoicePeriodEnd(invoice: Stripe.Invoice): Date | null {
  const ts = (invoice as any).lines?.data?.[0]?.period?.end;
  return typeof ts === "number" ? new Date(ts * 1000) : null;
}

function subscriptionPeriodEnd(sub: Stripe.Subscription): Date | null {
  const anySub = sub as any;
  const ts = anySub.current_period_end ?? anySub.items?.data?.[0]?.current_period_end;
  return typeof ts === "number" ? new Date(ts * 1000) : null;
}

// Map Stripe's subscription.status to our enum. Unknown/transient states
// (incomplete, trialing) are left as-is by the caller.
function mapStripeStatus(status: Stripe.Subscription.Status): "ACTIVE" | "PAST_DUE" | "CANCELED" | null {
  switch (status) {
    case "active":
      return "ACTIVE";
    case "past_due":
    case "unpaid":
      return "PAST_DUE";
    case "canceled":
      return "CANCELED";
    default:
      return null;
  }
}

async function handleSubscriptionCheckout(event: Stripe.Event, session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId;
  if (!userId) return;
  const stripeSubscriptionId = typeof session.subscription === "string" ? session.subscription : null;
  const customerId = typeof session.customer === "string" ? session.customer : null;

  const sub = await prisma.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  });
  if (!sub) {
    console.warn(`[stripe-webhook] sub checkout for ${userId} but no Subscription row`);
    return;
  }

  // Idempotent: a re-delivered checkout.completed for the same sub is a no-op.
  if (sub.status === "ACTIVE" && sub.stripeSubscriptionId === stripeSubscriptionId) return;

  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { userId },
      data: {
        status: "ACTIVE",
        billingMode: "STRIPE",
        stripeSubscriptionId,
        canceledAt: null,
      },
    });
    if (customerId) {
      await tx.user.update({ where: { id: userId }, data: { stripeCustomerId: customerId } });
    }
  });

  console.log(`[stripe-webhook] sub ACTIVE for ${userId} (stripe ${stripeSubscriptionId}, evt ${event.id})`);

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, username: true } });
  if (user) {
    const { subject, html, text } = subscriptionStartedEmail({
      username: user.username,
      priceLabel: formatPrice(sub.plan.priceCents, sub.plan.currency, sub.plan.interval),
      eggsPerDelivery: sub.plan.eggsPerDelivery,
      appUrl: appUrl(),
    });
    void sendEmail({ to: user.email, subject, html, text });
  }
}

async function handleInvoicePaid(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
  if (!stripeSubscriptionId) return; // not a subscription invoice

  // Idempotency: one SubscriptionPayment per webhook event id.
  const already = await prisma.subscriptionPayment.findFirst({
    where: { stripeEventId: event.id },
    select: { id: true },
  });
  if (already) return;

  const sub = await prisma.subscription.findUnique({ where: { stripeSubscriptionId } });
  if (!sub) {
    console.warn(`[stripe-webhook] invoice paid for unknown sub ${stripeSubscriptionId}`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.subscriptionPayment.create({
      data: {
        id: makeId(ID_PREFIX.SUBSCRIPTION_PAYMENT),
        subscriptionId: sub.id,
        userId: sub.userId,
        stripeEventId: event.id,
        stripeInvoiceId: invoice.id,
        amountCents: invoice.amount_paid,
        currency: invoice.currency,
        mode: "STRIPE",
      },
    });
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        status: "ACTIVE",
        currentPeriodEnd: invoicePeriodEnd(invoice),
      },
    });
  });

  console.log(
    `[stripe-webhook] egg delivery recorded for ${sub.userId} (${invoice.amount_paid} ${invoice.currency}, evt ${event.id})`,
  );
}

async function handleInvoiceFailed(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice;
  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
  if (!stripeSubscriptionId) return;

  const sub = await prisma.subscription.findUnique({ where: { stripeSubscriptionId } });
  if (!sub) return;

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { status: "PAST_DUE" },
  });
  console.log(`[stripe-webhook] sub PAST_DUE for ${sub.userId} (evt ${event.id})`);

  const user = await prisma.user.findUnique({ where: { id: sub.userId }, select: { email: true, username: true } });
  if (user) {
    const { subject, html, text } = paymentFailedEmail({ username: user.username, appUrl: appUrl() });
    void sendEmail({ to: user.email, subject, html, text });
  }
}

async function handleSubscriptionUpdated(event: Stripe.Event) {
  const stripeSub = event.data.object as Stripe.Subscription;
  const sub = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: stripeSub.id } });
  if (!sub) return;

  const mapped = mapStripeStatus(stripeSub.status);
  await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      ...(mapped ? { status: mapped } : {}),
      currentPeriodEnd: subscriptionPeriodEnd(stripeSub),
      ...(mapped === "CANCELED" ? { canceledAt: new Date() } : {}),
    },
  });
  console.log(`[stripe-webhook] sub updated for ${sub.userId} → ${mapped ?? stripeSub.status} (evt ${event.id})`);
}

async function handleSubscriptionDeleted(event: Stripe.Event) {
  const stripeSub = event.data.object as Stripe.Subscription;
  const sub = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: stripeSub.id } });
  if (!sub) return;

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { status: "CANCELED", canceledAt: new Date() },
  });
  console.log(`[stripe-webhook] sub CANCELED for ${sub.userId} (evt ${event.id})`);
}
