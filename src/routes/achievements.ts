import { Hono } from "hono";
import { prisma } from "../utils/db";

export const achievements = new Hono();

// GET /achievements — public catalog of every active achievement (the whole
// "Pokédex"). The FE cross-references this against a user's earned list
// (GET /users/:id/achievements) to render locked vs unlocked tiles. Internal
// catalog fields (key, threshold) stay off the wire — only display data ships.
achievements.get("/", async (c) => {
  const rows = await prisma.achievement.findMany({
    where: { active: true },
    orderBy: [{ metric: "asc" }, { threshold: "asc" }],
    select: { id: true, name: true, description: true, metric: true, rewardCoins: true },
  });
  return c.json({ achievements: rows });
});
