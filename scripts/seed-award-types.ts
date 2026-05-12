import { prisma } from "../src/utils/db";
import { makeId, ID_PREFIX } from "../src/utils/ids";

// Award catalog seed. assetKey is the source of truth — it maps to local
// asset files on the frontend (e.g. `/awards/award_1.svg`, possibly also
// `.json` for motion, `.wav` for sound) so renaming the display `name`
// later does not break asset lookups. priceCoins is the cost charged to
// the granter at the moment of granting; PostAward.coinsSpent snapshots
// this value so historical grants stay honest if prices change.

type AwardSeed = {
  assetKey: string;
  name: string;
  priceCoins: number;
};

const AWARDS: AwardSeed[] = [
  { assetKey: "award_1", name: "Award 1", priceCoins: 100 },
  { assetKey: "award_2", name: "Award 2", priceCoins: 250 },
  { assetKey: "award_3", name: "Award 3", priceCoins: 500 },
];

async function main() {
  for (const seed of AWARDS) {
    await prisma.awardType.upsert({
      where: { assetKey: seed.assetKey },
      create: {
        id: makeId(ID_PREFIX.AWARD_TYPE),
        assetKey: seed.assetKey,
        name: seed.name,
        priceCoins: seed.priceCoins,
        active: true,
      },
      update: {
        name: seed.name,
        priceCoins: seed.priceCoins,
        active: true,
      },
    });

    console.log(`  ${seed.assetKey.padEnd(12)} ${seed.name.padEnd(14)} ${seed.priceCoins} coins`);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
