import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { prisma } from "../utils/db";
import { bus } from "../events/bus";
import { rollIdentity } from "../utils/identity";
import { requireSignIn, type AuthVars } from "../middleware/require-sign-in";

export const users = new Hono<AuthVars>();

// ─────────────────────────────────────────────────────────────
// GET /users/count
// Public farm headcount — FE renders "N animals on the farm".
// Registered before the `/:userId/...` routes so the static path
// isn't shadowed. Cheap: `count` is a single COUNT(*) — no
// caching layer until traffic says otherwise.
// ─────────────────────────────────────────────────────────────

users.get("/count", async (c) => {
    const count = await prisma.user.count();
    return c.json({ count });
});

// ─────────────────────────────────────────────────────────────
// GET /users/:userId
// Public-facing profile — the identity card the FE renders when
// you tap a post/comment author. Carries the procedural-avatar
// inputs (animal + avatarSeed, varied by gender), account age,
// and activity counts. Private fields (email, coin balances) are
// deliberately NOT exposed — those belong to the owner's session.
// Registered after `/count` so the static path isn't shadowed by
// this `:userId` param route.
// ─────────────────────────────────────────────────────────────

users.get("/:userId", async (c) => {
    const userId = c.req.param("userId");

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            username: true,
            gender: true,
            animal: true,
            avatarSeed: true,
            createdAt: true,
            // Filtered relation counts — soft-deleted rows must not
            // inflate a public profile's activity stats.
            _count: {
                select: {
                    posts: { where: { deletedAt: null } },
                    comments: { where: { deletedAt: null } },
                },
            },
        },
    });

    if (!user) return c.json({ error: "user not found" }, 404);

    return c.json({
        id: user.id,
        username: user.username,
        gender: user.gender,
        animal: user.animal,
        avatarSeed: user.avatarSeed,
        createdAt: user.createdAt.toISOString(),
        postCount: user._count.posts,
        commentCount: user._count.comments,
    });
});

// Whitelist of acceptable `?target=` values. Anything else 400s rather than
// silently returning both arrays — protects against frontend typos like
// `?target=Post` (capital P) going unnoticed.
const VALID_TARGETS = ["posts", "comments"] as const;
type Target = (typeof VALID_TARGETS)[number];

// A vote outlives the content it points at — the post or comment can be
// soft-deleted after the vote was cast. Mirror the Reddit-style redaction
// in GET /posts/:id/comments: keep the row (pagination stays stable) but
// scrub title/body + author so deleted content can't leak out through a
// third party's public vote history. `author: null` is the deletion
// signal documented by the contract's nullable `author`.
function redactPostVote<T extends { post: { deletedAt: Date | null; title: string; body: string; author: unknown } }>(vote: T) {
    if (!vote.post.deletedAt) return vote;
    return { ...vote, post: { ...vote.post, title: "[deleted]", body: "[deleted]", author: null } };
}

function redactCommentVote<T extends { comment: { deletedAt: Date | null; body: string; author: unknown } }>(vote: T) {
    if (!vote.comment.deletedAt) return vote;
    return { ...vote, comment: { ...vote.comment, body: "[deleted]", author: null } };
}

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
                        deletedAt: true,
                        upvoteCount: true,
                        downvoteCount: true,
                        post: { select: { id: true } },
                        author: { select: { id: true, username: true, gender: true, animal: true, avatarSeed: true } },
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
                        deletedAt: true,
                        createdAt: true,
                        updatedAt: true,
                        upvoteCount: true,
                        downvoteCount: true,
                        author: { select: { id: true, username: true, gender: true, animal: true, avatarSeed: true } },
                    },
                },
            },
        }),
    ]);

    if (!user) return c.json({ error: "user not found" }, 404);

    // Redact any post/comment soft-deleted after its vote was cast.
    const posts = postVotes.map(redactPostVote);
    const comments = commentVotes.map(redactCommentVote);

    if (target === "comments") return c.json({ commentVotes: comments, page, limit });
    if (target === "posts") return c.json({ postVotes: posts, page, limit });
    return c.json({ commentVotes: comments, postVotes: posts, page, limit });
});

// ─────────────────────────────────────────────────────────────
// GET /users/:userId/achievements
// Public. Lists which catalog achievements this user has earned,
// with rewardCoins snapshot and grantedAt.
// ─────────────────────────────────────────────────────────────

users.get("/:userId/achievements", async (c) => {
    const userId = c.req.param("userId");

    const [user, rows] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
        prisma.userAchievement.findMany({
            where: { userId },
            orderBy: { grantedAt: "desc" },
            select: {
                grantedAt: true,
                achievement: {
                    // Matches the contract's `Achievement` shape. `key` and
                    // `threshold` are internal catalog fields (stable handle +
                    // earn condition) — not display data, kept off this public
                    // endpoint. `rewardCoins` is the payout the FE renders.
                    select: { id: true, name: true, description: true, metric: true, rewardCoins: true },
                },
            },
        }),
    ]);

    if (!user) return c.json({ error: "user not found" }, 404);

    return c.json({ achievements: rows });
});

// ─────────────────────────────────────────────────────────────
// POST /users/me/avatar/reroll
// Atomically picks a new (animal, avatarSeed) for the current user.
// Each click of the FE's "generate" button hits this — there's no
// staging state, no separate "keep this one" commit. The roll IS
// the commit. Future griefing-resistance ideas: 30-day cooldown,
// limited free rerolls per month — defer until needed.
// ─────────────────────────────────────────────────────────────

users.post("/me/avatar/reroll", requireSignIn, async (c) => {
    const userId = c.get("userId");
    const next = rollIdentity();

    const updated = await prisma.user.update({
        where: { id: userId },
        data: { animal: next.animal, avatarSeed: next.avatarSeed },
        select: { animal: true, avatarSeed: true },
    });

    return c.json(updated);
});

// ─────────────────────────────────────────────────────────────
// GET /users/me/events — SSE stream
// One open HTTP connection per signed-in client. Server pushes
// achievement_unlocked events (and future event types) the
// instant they fire on the bus, scoped to this user. Frontend
// subscribes once on sign-in, listens forever, renders toasts.
// ─────────────────────────────────────────────────────────────

users.get("/me/events", requireSignIn, async (c) => {
    const userId = c.get("userId");

    return streamSSE(c, async (stream) => {
        // Initial "hello" event so the client knows the stream opened.
        // Some browsers/proxies hold the first byte; this flushes.
        await stream.writeSSE({ event: "connected", data: JSON.stringify({ userId }) });
        console.log(`[sse] ${userId} connected`);

        // Subscribe to the bus, filtered by this user's id. The returned
        // unsubscribe is captured so we can clean up when the client
        // disconnects (otherwise we'd leak a listener per request).
        const unsubscribe = bus.on("achievement_unlocked", async (event) => {
            if (event.userId !== userId) return;
            await stream.writeSSE({
                event: "achievement_unlocked",
                data: JSON.stringify({
                    achievement: event.achievement,
                    newCoinBalance: event.newCoinBalance,
                }),
            });
        });

        // Heartbeat — without periodic traffic, intermediate proxies (or
        // Bun's own connection management) can drop an idle SSE stream.
        // A comment line every 25s keeps the pipe warm without spamming
        // the client with meaningful events.
        const heartbeat = setInterval(() => {
            stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
        }, 25_000);

        // Hono's stream resolves the outer promise when the client
        // disconnects (via stream.onAbort). Clean up listeners + timer.
        stream.onAbort(() => {
            unsubscribe();
            clearInterval(heartbeat);
            console.log(`[sse] ${userId} disconnected`);
        });

        // Hold the stream open by awaiting a never-resolving promise.
        // The client controls termination via abort.
        await new Promise<void>(() => {});
    });
});