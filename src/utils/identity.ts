import { Animal } from "../generated/prisma/client";

// Pigweed animal roll. Pure function, no side effects — called at signup
// (via the Better Auth before-create hook) AND at /me/avatar/reroll.
//
// avatarSeed is a 31-bit non-negative integer — the frontend hashes it
// into palette/pattern picks. 31-bit so it fits comfortably in a Postgres
// Int column and a JS Number.
//
// Animal pool: each has a default profile icon in the FE assets bucket
// (<animal>-user-icon.webp). Adding more = enum migration + a new icon in R2.

const ANIMAL_POOL: Animal[] = ["CHICKEN", "DOG", "GOOSE", "DUCK", "CAT", "LIZARD"];
const SEED_MAX = 2 ** 31;

export function rollIdentity(): { animal: Animal; avatarSeed: number } {
  return {
    animal: ANIMAL_POOL[Math.floor(Math.random() * ANIMAL_POOL.length)],
    avatarSeed: Math.floor(Math.random() * SEED_MAX),
  };
}
