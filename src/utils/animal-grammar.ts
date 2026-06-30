import { Animal } from "../generated/prisma/client";

// English pluralization for the Animal enum. Most animals are regular
// (just add "s"), so this map only lists the IRREGULAR ones — anything not
// here falls through to the default `${animal}s`. Keyed by the enum so a
// new irregular animal (OX → oxen, MOUSE → mice, SHEEP → sheep …) gets a
// deliberate entry here instead of silently rendering "gooses".
const IRREGULAR_PLURALS: Partial<Record<Animal, string>> = {
  GOOSE: "geese",
};

/**
 * Lowercase English plural for an animal name. Case-insensitive in,
 * lowercase out (email copy lowercases the animal):
 *   "goose" → "geese", "GOOSE" → "geese", "chicken" → "chickens".
 * Unknown/regular animals just get a trailing "s".
 */
export function pluralizeAnimal(animal: string): string {
  const key = animal.toUpperCase() as Animal;
  return IRREGULAR_PLURALS[key] ?? `${animal.toLowerCase()}s`;
}
