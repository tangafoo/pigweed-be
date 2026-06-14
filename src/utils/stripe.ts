import Stripe from "stripe";
import { stripeSecretKey, stripeWebhookSecret as readWebhookSecret } from "./env";

// env.ts validates STRIPE_SECRET_KEY is present at boot, so no guard here.
export const stripe = new Stripe(stripeSecretKey());

export const stripeWebhookSecret = readWebhookSecret();
