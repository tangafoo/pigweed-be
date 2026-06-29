import Stripe from "stripe";
import { stripeSecretKey, stripeWebhookSecret as readWebhookSecret } from "./env";

// stripeSecretKey() throws if unset; this module is imported only by the API
// server (never the crons), and assertWebEnv() guarantees the key at boot.
export const stripe = new Stripe(stripeSecretKey());

export const stripeWebhookSecret = readWebhookSecret();
