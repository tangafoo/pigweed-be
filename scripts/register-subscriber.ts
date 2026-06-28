import { prisma } from "../src/utils/db";
import { auth } from "../src/utils/auth";
import { rollIdentity } from "../src/utils/identity";
import { sendEmail } from "../src/utils/email";
import { welcomeEmail } from "../src/emails/templates";
import { appUrl } from "../src/utils/env";
import { getPlanByEggs, subscribeUser } from "../src/utils/subscriptions";
import type { Gender } from "../src/generated/prisma/client";

// ─────────────────────────────────────────────────────────────
// REGISTER A SUBSCRIBER FROM JUST AN EMAIL — for onboarding the
// existing manual egg customers ("aunties") without making them
// sign up. Creates the User row directly via Prisma (this bypasses
// Better Auth's signup hooks, so we replicate them here: roll the
// animal/avatar, mirror displayUsername), emails a welcome + a
// one-click magic-link login. No password is ever set — they log
// in by link (and can add a passkey later).
//
// Usage:
//   bun run subscriber:register <email> [username] [gender] [--subscribe 30|60|120]
//   gender ∈ MALE | FEMALE | NONBINARY | UNDISCLOSED (default UNDISCLOSED)
//   --subscribe <eggs>  also activates a MANUAL subscription on that tier
//                       (the admin-panel "subscribe this user?" checkbox)
//
// Idempotent: if the email already exists, it just re-sends the magic link
// (and applies --subscribe if given).
// ─────────────────────────────────────────────────────────────

const GENDERS: Gender[] = ["MALE", "FEMALE", "NONBINARY", "UNDISCLOSED"];
const TIER_EGGS = [30, 60, 120];

// Pull "--subscribe <n>" / "--subscribe=<n>" out of argv; return the eggs
// number (or null) plus the remaining positional args.
function parseArgs(argv: string[]): { positional: string[]; subscribeEggs: number | null } {
  const positional: string[] = [];
  let subscribeEggs: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--subscribe") {
      subscribeEggs = Number(argv[++i]);
    } else if (a.startsWith("--subscribe=")) {
      subscribeEggs = Number(a.split("=")[1]);
    } else {
      positional.push(a);
    }
  }
  return { positional, subscribeEggs };
}

// Activate a MANUAL subscription on the tier matching `eggs`. Logs + no-ops
// on a bad tier rather than throwing (registration already succeeded).
async function applySubscription(userId: string, eggs: number): Promise<void> {
  if (!TIER_EGGS.includes(eggs)) {
    console.warn(`--subscribe ${eggs}: not a tier (${TIER_EGGS.join("/")}). Skipped.`);
    return;
  }
  const plan = await getPlanByEggs(eggs);
  if (!plan) {
    console.warn(`No active ${eggs}-egg plan — run \`bun run seed:subscriptions\` first. Skipped.`);
    return;
  }
  await subscribeUser(userId, plan.id);
  console.log(`Subscribed to the ${eggs}-egg tier (MANUAL).`);
}

function sanitizeUsername(raw: string): string {
  let u = raw.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (u.length < 3) u = `${u}farm`;
  return u.slice(0, 30);
}

async function uniqueUsername(base: string): Promise<string> {
  let candidate = base;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } })) {
    const suffix = String(n++);
    candidate = base.slice(0, 30 - suffix.length) + suffix;
  }
  return candidate;
}

async function sendLoginLink(email: string): Promise<void> {
  // Triggers the magicLink plugin's sendMagicLink → magicLinkEmail (or a
  // dev-console fallback with no RESEND_API_KEY). callbackURL is where the
  // FE lands after the token verifies.
  await auth.api.signInMagicLink({
    // Server-side call (no incoming request) — Better Auth still types
    // `headers` as required on this endpoint, so pass an empty set.
    headers: {},
    body: { email, callbackURL: appUrl() },
  });
}

async function main() {
  const { positional, subscribeEggs } = parseArgs(process.argv.slice(2));
  const email = positional[0]?.trim().toLowerCase();
  const usernameArg = positional[1]?.trim();
  const genderArg = positional[2]?.trim().toUpperCase();

  if (!email || !email.includes("@")) {
    console.error("Usage: bun run subscriber:register <email> [username] [gender] [--subscribe 30|60|120]");
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, username: true },
  });
  if (existing) {
    console.log(`User already exists: ${existing.username} <${email}> — re-sending login link.`);
    if (subscribeEggs !== null) await applySubscription(existing.id, subscribeEggs);
    await sendLoginLink(email);
    console.log("Magic-link login email sent (or logged in dev).");
    return;
  }

  const gender: Gender = GENDERS.includes(genderArg as Gender)
    ? (genderArg as Gender)
    : "UNDISCLOSED";

  const username = await uniqueUsername(
    sanitizeUsername(usernameArg || email.split("@")[0]),
  );
  const { animal, avatarSeed } = rollIdentity();
  const id = crypto.randomUUID().replace(/-/g, "");

  await prisma.user.create({
    data: {
      id,
      name: username,
      email,
      // Magic-link login proves the address; mark it verified so a future
      // requireEmailVerification flip doesn't lock these accounts out.
      emailVerified: true,
      username,
      displayUsername: username,
      gender,
      animal,
      avatarSeed,
    },
  });

  console.log(`Created ${username} <${email}> as ${animal} (seed ${avatarSeed}).`);

  if (subscribeEggs !== null) await applySubscription(id, subscribeEggs);

  // Welcome email (mirrors the Better Auth after-create hook we bypassed).
  const welcome = welcomeEmail({ username, animal, appUrl: appUrl() });
  await sendEmail({ to: email, ...welcome });

  // One-click login link.
  await sendLoginLink(email);
  console.log("Welcome + magic-link login emails sent (or logged in dev).");
  console.log(`Next: bun run subscriber:subscribe ${email}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
