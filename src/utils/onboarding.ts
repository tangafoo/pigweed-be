import { prisma } from "./db";
import { auth } from "./auth";
import { rollIdentity } from "./identity";
import { appUrl } from "./env";
import type { Gender } from "../generated/prisma/client";

// ─────────────────────────────────────────────────────────────
// EMAIL-ONLY ONBOARDING — create (or find) a user from just an email
// and send them a magic-link login. Shared by the admin "Add user"
// endpoint and the CLI register-subscriber script. Bypasses Better
// Auth's HTTP signup, so it replicates the bits the signup hook does:
// roll the animal/avatar, mirror displayUsername, mark email verified.
// ─────────────────────────────────────────────────────────────

const GENDERS: Gender[] = ["MALE", "FEMALE", "NONBINARY", "UNDISCLOSED"];
const ANIMALS = ["CHICKEN", "DOG", "GOOSE", "DUCK", "CAT", "LIZARD"] as const;
type AnimalName = (typeof ANIMALS)[number];

function sanitizeUsername(raw: string): string {
  let u = raw.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (u.length < 3) u = `${u}farm`;
  return u.slice(0, 30);
}

async function uniqueUsername(base: string): Promise<string> {
  let candidate = base;
  let n = 1;
  while (await prisma.user.findUnique({ where: { username: candidate }, select: { id: true } })) {
    const suffix = String(n++);
    candidate = base.slice(0, 30 - suffix.length) + suffix;
  }
  return candidate;
}

// Triggers the magicLink plugin's sendMagicLink → magicLinkEmail (or the dev
// console fallback). The email greets them with their username + animal.
export async function sendLoginLink(email: string): Promise<void> {
  await auth.api.signInMagicLink({
    headers: {},
    body: { email, callbackURL: appUrl() },
  });
}

export type RegisterResult = {
  id: string;
  username: string;
  animal: string;
  email: string;
  /** True when the email already had an account (we just re-sent the link). */
  existed: boolean;
};

// Playful farm words for the no-email fallback so each reroll/open differs.
const FARM_WORDS = [
  "sprout", "clover", "henny", "yolk", "pebble", "biscuit", "maize",
  "willow", "ginger", "poppy", "barley", "nutmeg", "hazel", "pumpkin",
];

// A previewable identity (unique username + random animal) the admin can
// reroll + confirm before the user is created. Username base comes from the
// email local-part when present, else a random farm word (so each call varies).
export async function previewIdentity(email?: string): Promise<{ username: string; animal: string }> {
  const base =
    email && email.includes("@")
      ? sanitizeUsername(email.split("@")[0])
      : `${FARM_WORDS[Math.floor(Math.random() * FARM_WORDS.length)]}_${Math.floor(Math.random() * 1000)}`;
  const username = await uniqueUsername(base);
  const { animal } = rollIdentity();
  return { username, animal };
}

export async function registerUserByEmail(input: {
  email: string;
  username?: string;
  gender?: string;
  /** Confirmed animal from the preview; rolled if omitted/invalid. */
  animal?: string;
}): Promise<RegisterResult> {
  const email = input.email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, username: true, animal: true },
  });
  if (existing) {
    await sendLoginLink(email);
    return { id: existing.id, username: existing.username, animal: existing.animal, email, existed: true };
  }

  const gender: Gender =
    input.gender && GENDERS.includes(input.gender.toUpperCase() as Gender)
      ? (input.gender.toUpperCase() as Gender)
      : "UNDISCLOSED";
  const rolled = rollIdentity();
  const animal: AnimalName =
    input.animal && ANIMALS.includes(input.animal.toUpperCase() as AnimalName)
      ? (input.animal.toUpperCase() as AnimalName)
      : rolled.animal;
  const base = sanitizeUsername(input.username?.trim() || email.split("@")[0]);

  // uniqueUsername() dedupes against the DB, but a concurrent signup could
  // still grab the same handle between the check and the insert. The DB's
  // `username @unique` constraint is the real guarantee — on a P2002 race we
  // recompute a fresh handle and retry. A P2002 on `email` means someone
  // registered this address concurrently → treat it as "already existed".
  let created: { id: string; username: string } | null = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const username = await uniqueUsername(base);
    const id = crypto.randomUUID().replace(/-/g, "");
    try {
      await prisma.user.create({
        data: {
          id,
          name: username,
          email,
          // Magic-link login proves the address; mark verified so a future
          // requireEmailVerification flip doesn't lock these accounts out.
          emailVerified: true,
          username,
          displayUsername: username,
          gender,
          animal,
          avatarSeed: rolled.avatarSeed,
        },
      });
      created = { id, username };
    } catch (err: unknown) {
      const e = err as { code?: string; meta?: { target?: unknown } };
      if (e?.code !== "P2002") throw err;
      const target = String(e?.meta?.target ?? "");
      if (target.includes("email")) {
        const u = await prisma.user.findUnique({
          where: { email },
          select: { id: true, username: true, animal: true },
        });
        if (u) {
          await sendLoginLink(email);
          return { id: u.id, username: u.username, animal: u.animal, email, existed: true };
        }
      }
      // username race — loop recomputes a fresh unique handle and retries.
    }
  }

  if (!created) throw new Error("could not allocate a unique username");

  console.log(`[onboarding] registered ${created.username} <${email}> as ${animal}`);
  await sendLoginLink(email);
  return { id: created.id, username: created.username, animal, email, existed: false };
}
