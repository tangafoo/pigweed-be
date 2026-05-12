import { prisma } from "../src/utils/db";
import { makeId, ID_PREFIX } from "../src/utils/ids";
import { stripe } from "../src/utils/stripe";

type PackSeed = {
  lookupKey: string;
  name: string;
  coins: number;
  priceCents: number;
};

const PACKS: PackSeed[] = [
  { lookupKey: "coin_pack_starter", name: "Starter Pack", coins: 500,  priceCents: 199 },
  { lookupKey: "coin_pack_handful", name: "Handful",      coins: 1100, priceCents: 399 },
  { lookupKey: "coin_pack_pile",    name: "Pile",         coins: 1800, priceCents: 599 },
  { lookupKey: "coin_pack_hoard",   name: "Hoard",        coins: 5500, priceCents: 1999 },
];

async function findOrCreatePrice(seed: PackSeed) {
  const existing = await stripe.prices.list({ lookup_keys: [seed.lookupKey], limit: 1 });
  if (existing.data[0]) return existing.data[0];

  const product = await stripe.products.create({
    name: seed.name,
    metadata: { kind: "coin_pack", coins: String(seed.coins) },
  });

  return stripe.prices.create({
    product: product.id,
    unit_amount: seed.priceCents,
    currency: "usd",
    lookup_key: seed.lookupKey,
  });
}

async function main() {
  for (const seed of PACKS) {
    const price = await findOrCreatePrice(seed);

    await prisma.coinPack.upsert({
      where: { stripePriceId: price.id },
      create: {
        id: makeId(ID_PREFIX.COIN_PACK),
        name: seed.name,
        coins: seed.coins,
        priceCents: seed.priceCents,
        currency: "usd",
        stripePriceId: price.id,
        active: true,
      },
      update: {
        name: seed.name,
        coins: seed.coins,
        priceCents: seed.priceCents,
        active: true,
      },
    });

    console.log(`  ${seed.name.padEnd(14)} ${seed.coins} coins  $${(seed.priceCents / 100).toFixed(2)}  ${price.id}`);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
