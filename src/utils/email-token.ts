import { createHmac, timingSafeEqual } from "node:crypto";
import { betterAuthUrl, emailTokenSecret } from "./env";

// ─────────────────────────────────────────────────────────────
// UNSUBSCRIBE TOKENS — stateless, signed one-click opt-out links.
//
// The digest footer needs a link that turns digests off for exactly one
// user, can't be forged into "unsubscribe someone else," and needs no DB
// table to track. So: HMAC the userId with EMAIL_TOKEN_SECRET (a dedicated
// secret so the digest cron can sign links without holding BETTER_AUTH_SECRET;
// falls back to it for single-secret deploys). The link carries (userId,
// token); the endpoint recomputes the HMAC and compares in constant time. No
// expiry — a valid unsubscribe link is a feature, not a risk.
// ─────────────────────────────────────────────────────────────

function secret(): string {
  return emailTokenSecret();
}

export function unsubscribeToken(userId: string): string {
  return createHmac("sha256", secret())
    .update(`unsubscribe:${userId}`)
    .digest("hex");
}

export function verifyUnsubscribeToken(userId: string, token: string): boolean {
  const expected = unsubscribeToken(userId);
  // Lengths must match before timingSafeEqual (it throws on mismatch).
  if (token.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Full link dropped into the digest footer. Points at the BE host, which
// serves GET /email/unsubscribe (see routes/email.ts).
export function unsubscribeUrl(userId: string): string {
  const base = betterAuthUrl().replace(/\/+$/, "");
  return `${base}/email/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`;
}
