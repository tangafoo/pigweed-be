import { prisma } from "../src/utils/db";
import { makeId, ID_PREFIX } from "../src/utils/ids";
import { AchievementMetric } from "../src/generated/prisma/client";

// Achievement catalog seed. The `key` is the stable identifier the code
// uses to look these up if it ever needs to (currently it doesn't —
// everything is data-driven via metric + threshold). Adding a new
// achievement: append a row here and re-run `bun seed:achievements`. The
// upsert is keyed on `key` so re-runs are safe.

type AchievementSeed = {
  key: string;
  name: string;
  description: string;
  metric: AchievementMetric;
  threshold: number;
  rewardCoins: number;
};

const ACHIEVEMENTS: AchievementSeed[] = [
  {
    key: "first_post",
    name: "First Post",
    description: "Plant your first sprout — make your first post.",
    metric: "POSTS_CREATED",
    threshold: 1,
    rewardCoins: 100,
  },
  {
    key: "first_review",
    name: "First Review",
    description: "Leave your first review — a post with a star rating.",
    metric: "REVIEWS_CREATED",
    threshold: 1,
    rewardCoins: 100,
  },
  {
    key: "hundred_posts",
    name: "The Garden Grows",
    description: "Make 100 posts.",
    metric: "POSTS_CREATED",
    threshold: 100,
    rewardCoins: 500,
  },
  {
    key: "first_comment",
    name: "First Reply",
    description: "Leave your first comment.",
    metric: "COMMENTS_CREATED",
    threshold: 1,
    rewardCoins: 50,
  },
  // generous_soul intentionally removed: the Postgres trigger already
  // grants +5 unlockCoins on every 10th award, so an additional coinBalance
  // bonus on the same milestone would double-dip.
  {
    key: "founding_flock",
    name: "Founding Flock",
    description: "One of the first to join the farm — a founding flock member.",
    // MANUAL: never auto-evaluated. Granted only when an admin toggles the
    // founding-flock flair on a user (see routes/admin.ts). Threshold is a
    // formality; evaluateMetric("MANUAL") always returns 0.
    metric: "MANUAL",
    threshold: 1,
    rewardCoins: 200,
  },
];

async function main() {
  for (const seed of ACHIEVEMENTS) {
    await prisma.achievement.upsert({
      where: { key: seed.key },
      create: {
        id: makeId(ID_PREFIX.ACHIEVEMENT),
        key: seed.key,
        name: seed.name,
        description: seed.description,
        metric: seed.metric,
        threshold: seed.threshold,
        rewardCoins: seed.rewardCoins,
        active: true,
      },
      update: {
        name: seed.name,
        description: seed.description,
        metric: seed.metric,
        threshold: seed.threshold,
        rewardCoins: seed.rewardCoins,
        active: true,
      },
    });

    console.log(`  ${seed.key.padEnd(18)} ${seed.name.padEnd(20)} ${seed.metric.padEnd(20)} >=${seed.threshold} → ${seed.rewardCoins} coins`);
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
