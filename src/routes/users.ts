import { Hono } from "hono";
import { prisma } from "../utils/db";
import { type AuthVars } from "../middleware/require-sign-in";

export const users = new Hono<AuthVars>();

// Whitelist of acceptable `?target=` values. Anything else 400s rather than
// silently returning both arrays — protects against frontend typos like
// `?target=Post` (capital P) going unnoticed.
const VALID_TARGETS = ["posts", "comments"] as const;
type Target = (typeof VALID_TARGETS)[number];

users.get("/:userId/votes", async (c) => {
    const userId = c.req.param("userId");

    const target = c.req.query("target");
    if (target !== undefined && !VALID_TARGETS.includes(target as Target)) {
        return c.json({ error: `target must be one of: ${VALID_TARGETS.join(", ")}` }, 400);
    }

    const page = Math.max(1, Number(c.req.query("page") ?? 1));
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));

    // User existence check folded into the same Promise.all as the vote
    // queries — one round-trip when the user exists (the common path). If the
    // user is missing we discard the vote results, but that case is the
    // exception, not the rule.
    const [user, commentVotes, postVotes] = await Promise.all([
        prisma.user.findUnique({
            where: { id: userId },
            select: { id: true },
        }),
        prisma.commentVote.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit,
            take: limit,
            select: {
                value: true,
                commentId: true,
                createdAt: true,
                comment: {
                    select: {
                        body: true,
                        upvoteCount: true,
                        downvoteCount: true,
                        post: { select: { id: true } },
                        author: { select: { id: true, name: true, image: true } },
                    },
                },
            },
        }),
        prisma.postVote.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit,
            take: limit,
            select: {
                value: true,
                postId: true,
                createdAt: true,
                post: {
                    select: {
                        title: true,
                        body: true,
                        createdAt: true,
                        updatedAt: true,
                        upvoteCount: true,
                        downvoteCount: true,
                        author: { select: { id: true, name: true, image: true } },
                    },
                },
            },
        }),
    ]);

    if (!user) return c.json({ error: "user not found" }, 404);

    if (target === "comments") return c.json({ commentVotes, page, limit });
    if (target === "posts") return c.json({ postVotes, page, limit });
    return c.json({ commentVotes, postVotes, page, limit });
});