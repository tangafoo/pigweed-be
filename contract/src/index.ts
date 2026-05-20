/**
 * @meteorclass/pigweed-contract — the single source of truth for pigweed's API surface.
 *
 * Every shape is a zod schema; the matching TypeScript type is `z.infer`'d
 * from it, so there is exactly one definition per concept.
 *
 *   - pigweed-be  imports the *schemas* and `.parse()`s requests against
 *     them at runtime (incrementally replacing hand-rolled validation).
 *   - pigweed-fe  imports the *types* (`import type { Post } ...`); zod is
 *     tree-shaken out of the browser bundle since only types are used.
 *
 * Enums mirror prisma/schema.prisma. Wire shapes mirror the API contract
 * documented in pigweed-be/CLAUDE.md. When the schema or an endpoint
 * changes, change it HERE, bump the version, and publish — never patch a
 * copy in the frontend.
 */
import { z } from 'zod';

/* ─── Enums (mirror prisma/schema.prisma) ─────────────────────────── */

export const Animal = z.enum(['CHICKEN', 'DOG', 'GOOSE']);
export type Animal = z.infer<typeof Animal>;

export const Gender = z.enum(['MALE', 'FEMALE', 'NONBINARY', 'UNDISCLOSED']);
export type Gender = z.infer<typeof Gender>;

export const VoteValue = z.enum(['UP', 'DOWN']);
export type VoteValue = z.infer<typeof VoteValue>;

export const AchievementMetric = z.enum([
	'POSTS_CREATED',
	'COMMENTS_CREATED',
	'AWARDS_GRANTED'
]);
export type AchievementMetric = z.infer<typeof AchievementMetric>;

/** PostMedia.kind is a free String column; BE accepts only these. */
export const MediaKind = z.enum(['image', 'video', 'gif']);
export type MediaKind = z.infer<typeof MediaKind>;

/** Echoed by GET /posts so the FE can show which tab is actually active. */
export const Sort = z.enum(['newest', 'rank']);
export type Sort = z.infer<typeof Sort>;

/** UI/email locale. pigweed launches with English + Korean; expansion is
 *  additive. The BE resolves the active locale from the Accept-Language
 *  header per request (see src/utils/i18n.ts); the FE picks it via a
 *  Paraglide cookie + Accept-Language fallback. Both ends import the
 *  enum from this contract so they cannot drift. */
export const Locale = z.enum(['en', 'ko']);
export type Locale = z.infer<typeof Locale>;

/* ─── Shared sub-shapes ───────────────────────────────────────────── */

/** Embedded author. `null` on a deleted comment. */
export const Author = z.object({
	id: z.string(),
	name: z.string(),
	image: z.string().nullable()
});
export type Author = z.infer<typeof Author>;

export const Media = z.object({
	id: z.string(),
	url: z.string(),
	kind: MediaKind,
	order: z.number().int(),
	width: z.number().int().nullable(),
	height: z.number().int().nullable()
});
export type Media = z.infer<typeof Media>;

/** Award badge stack carried on posts/comments, pre-sorted desc by count. */
export const AwardSummary = z.object({
	awardTypeId: z.string(),
	assetKey: z.string(),
	name: z.string(),
	count: z.number().int()
});
export type AwardSummary = z.infer<typeof AwardSummary>;

/** Catalog row from GET /awards/types. */
export const AwardType = z.object({
	id: z.string(),
	assetKey: z.string(),
	name: z.string(),
	priceCoins: z.number().int()
});
export type AwardType = z.infer<typeof AwardType>;

/* ─── Auth / session ──────────────────────────────────────────────── */

/**
 * The signed-in user. Better Auth's get-session returns all of this in
 * one call (additionalFields) — no separate hydrate fetch needed.
 */
export const SessionUser = z.object({
	id: z.string(),
	name: z.string(),
	email: z.string(),
	emailVerified: z.boolean(),
	image: z.string().nullable(),
	username: z.string(),
	gender: Gender,
	animal: Animal,
	avatarSeed: z.number().int(),
	coinBalance: z.number().int(),
	unlockCoins: z.number().int()
});
export type SessionUser = z.infer<typeof SessionUser>;

export const Session = z.object({
	user: SessionUser,
	session: z.object({ id: z.string(), expiresAt: z.string() })
});
export type Session = z.infer<typeof Session>;

/** GET /users/count — public farm headcount, used for "N animals on the farm" copy. */
export const UserCount = z.object({
	count: z.number().int().nonnegative()
});
export type UserCount = z.infer<typeof UserCount>;

/* ─── Posts ───────────────────────────────────────────────────────── */

export const Post = z.object({
	id: z.string(),
	title: z.string(),
	body: z.string(),
	latitude: z.number(),
	longitude: z.number(),
	createdAt: z.string(),
	updatedAt: z.string(),
	upvoteCount: z.number().int(),
	downvoteCount: z.number().int(),
	moderated: z.boolean(),
	author: Author,
	media: z.array(Media),
	/** The signed-in viewer's vote on this post. */
	myVote: VoteValue.nullable(),
	awards: z.array(AwardSummary)
});
export type Post = z.infer<typeof Post>;

export const FeedResponse = z.object({
	posts: z.array(Post),
	page: z.number().int(),
	limit: z.number().int(),
	radiusKm: z.number(),
	sort: Sort
});
export type FeedResponse = z.infer<typeof FeedResponse>;

/* ─── Comments ────────────────────────────────────────────────────── */

export const Comment = z.object({
	id: z.string(),
	postId: z.string(),
	parentCommentId: z.string().nullable(),
	depth: z.number().int(),
	/** `"[deleted]"` when soft-deleted (kept for tree integrity). */
	body: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
	deletedAt: z.string().nullable(),
	upvoteCount: z.number().int(),
	downvoteCount: z.number().int(),
	moderated: z.boolean(),
	/** `null` when the comment is deleted. */
	author: Author.nullable(),
	myVote: VoteValue.nullable(),
	awards: z.array(AwardSummary),
	/** Net score < -5 — collapse with click-to-reveal (body still present). */
	hidden: z.boolean()
});
export type Comment = z.infer<typeof Comment>;

export const RepliesResponse = z.object({
	parent: Comment,
	comments: z.array(Comment)
});
export type RepliesResponse = z.infer<typeof RepliesResponse>;

/* ─── Votes / coins ───────────────────────────────────────────────── */

export const VoteResponse = z.object({
	upvoteCount: z.number().int(),
	downvoteCount: z.number().int(),
	myVote: VoteValue.nullable()
});
export type VoteResponse = z.infer<typeof VoteResponse>;

export const CoinBalance = z.object({
	balance: z.number().int(),
	unlockCoins: z.number().int()
});
export type CoinBalance = z.infer<typeof CoinBalance>;

/* ─── Achievements (incl. SSE payload) ────────────────────────────── */

export const Achievement = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	metric: AchievementMetric.optional(),
	rewardCoins: z.number().int()
});
export type Achievement = z.infer<typeof Achievement>;

/** `achievement_unlocked` event body on GET /users/me/events. */
export const AchievementUnlockedEvent = z.object({
	achievement: Achievement,
	newCoinBalance: z.number().int()
});
export type AchievementUnlockedEvent = z.infer<typeof AchievementUnlockedEvent>;

/* ─── Request inputs (BE validates against these) ─────────────────── */

const TITLE_MAX = 200;
const BODY_MAX = 10000;
const MAX_MEDIA_PER_POST = 10;

export const MediaInput = z.object({
	url: z.string().url(),
	kind: MediaKind,
	order: z.number().int().nonnegative().optional(),
	width: z.number().int().nonnegative().optional(),
	height: z.number().int().nonnegative().optional()
});
export type MediaInput = z.infer<typeof MediaInput>;

export const PostInput = z.object({
	title: z.string().min(1).max(TITLE_MAX),
	body: z.string().max(BODY_MAX),
	latitude: z.number(),
	longitude: z.number(),
	media: z.array(MediaInput).max(MAX_MEDIA_PER_POST).optional()
});
export type PostInput = z.infer<typeof PostInput>;

export const PostPatchInput = z
	.object({
		title: z.string().min(1).max(TITLE_MAX).optional(),
		body: z.string().max(BODY_MAX).optional()
	})
	.refine((v) => v.title !== undefined || v.body !== undefined, {
		message: 'provide at least one of title, body'
	});
export type PostPatchInput = z.infer<typeof PostPatchInput>;

export const CommentInput = z.object({
	body: z.string().min(1),
	parentCommentId: z.string().optional()
});
export type CommentInput = z.infer<typeof CommentInput>;

export const CommentPatchInput = z.object({ body: z.string().min(1) });
export type CommentPatchInput = z.infer<typeof CommentPatchInput>;

export const VoteInput = z.object({ value: VoteValue });
export type VoteInput = z.infer<typeof VoteInput>;

export const AwardInput = z.object({ awardTypeId: z.string() });
export type AwardInput = z.infer<typeof AwardInput>;

/** Username rules come from the Better Auth username plugin (3–30). */
export const SignUpInput = z.object({
	email: z.string().email(),
	password: z.string().min(8),
	name: z.string().min(1),
	username: z.string().min(3).max(30),
	gender: Gender
});
export type SignUpInput = z.infer<typeof SignUpInput>;

export const SignInEmailInput = z.object({
	email: z.string().email(),
	password: z.string().min(1)
});
export type SignInEmailInput = z.infer<typeof SignInEmailInput>;

export const SignInUsernameInput = z.object({
	username: z.string().min(3).max(30),
	password: z.string().min(1)
});
export type SignInUsernameInput = z.infer<typeof SignInUsernameInput>;

/* ─── Error payloads ──────────────────────────────────────────────── */

export const ErrorCode = z.enum([
	'CONTENT_FLAGGED',
	'USERNAME_IS_ALREADY_TAKEN',
	'USERNAME_TOO_SHORT',
	'USERNAME_TOO_LONG'
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** 422 from POST /posts and POST /comments when moderation blocks. */
export const ContentFlaggedError = z.object({
	error: z.string(),
	code: z.literal('CONTENT_FLAGGED'),
	categories: z.array(z.string())
});
export type ContentFlaggedError = z.infer<typeof ContentFlaggedError>;

/** 402 from the granters endpoints when the viewer must pay to unlock. */
export const GrantersLockedError = z.object({
	error: z.string(),
	unlockCoins: z.number().int(),
	unlockEndpoint: z.string()
});
export type GrantersLockedError = z.infer<typeof GrantersLockedError>;
