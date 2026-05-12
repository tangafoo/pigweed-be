import { Hono } from "hono";
import { prisma } from "../utils/db";
import { type AuthVars } from "../middleware/require-sign-in";

export const users = new Hono<AuthVars>();

users.get("/:userId/votes", async (c) => {
    const userId = c.req.param("userId");
    const target = c.req.query("target");

    prisma.user.findUnique({
        where: { id: userId },
        select: { id: true }
    }).then(user => {
        if (!user) {
            return c.json({ error: "user not found" }, 404);
        }
    })

    const page = Math.max(1, Number(c.req.query("page") ?? 1));
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));

    const [commentVotes, postVotes] = await Promise.all([
        prisma.commentVote.findMany({
            where: { userId, comment: { deletedAt: null } },
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * limit,
            take: limit,
            select: {
                value: true,
                commentId: true,
                createdAt: true,
                comment:
                {
                    select:
                    {
                        body: true,
                        upvoteCount: true,
                        downvoteCount: true,
                        post: {
                            select: {
                                id: true
                            }
                        },
                        author: {
                            select: {
                                id: true,
                                name: true,
                                image: true
                            }
                        }
                    }
                }
            }
        }),
        prisma.postVote.findMany({
            where: { userId, post: { deletedAt: null } },
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
                        author: {
                            select: {
                                id: true,
                                name: true,
                                image: true
                            }
                        }
                    }
                }
            },
        })
    ]);

    if (target === "comments") {
        return c.json({ commentVotes, page, limit });
    } else if (target === "posts") {
        return c.json({ postVotes, page, limit });
    } else {
        return c.json({ commentVotes, postVotes, page, limit });
    }

})