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

/**
 * Produce category a post belongs to — backs the /posts page sections
 * (eggs / veggies / fruits). Nullable on a post: owner "farm update" posts
 * and other general chatter carry no category and live in the "all" bucket.
 */
export const PostCategory = z.enum(['EGGS', 'VEGGIES', 'FRUITS', 'ANIMALS']);
export type PostCategory = z.infer<typeof PostCategory>;

/** UI/email locale. pigweed launches with English + Korean; expansion is
 *  additive. The BE resolves the active locale from the Accept-Language
 *  header per request (see src/utils/i18n.ts); the FE picks it via a
 *  Paraglide cookie + Accept-Language fallback. Both ends import the
 *  enum from this contract so they cannot drift. */
export const Locale = z.enum(['en', 'ko', 'zh', 'ja']);
export type Locale = z.infer<typeof Locale>;

/* ─── Shared sub-shapes ───────────────────────────────────────────── */

/** Embedded author. `null` on a deleted comment. */
/**
 * The author identity embedded in every post/comment. Carries the
 * procedural-avatar inputs (`animal` + `avatarSeed`, varied by `gender`)
 * so feed cards can draw the avatar inline without a second fetch.
 * Better Auth's legacy `name`/`image` are intentionally NOT here — the
 * farm identity is the username + procedural avatar.
 */
export const Author = z.object({
	id: z.string(),
	/** Pigweed handle — Better Auth's normalized `username`. */
	username: z.string(),
	gender: Gender,
	animal: Animal,
	avatarSeed: z.number().int(),
	/**
	 * True when this author is an ourlittlefarm owner — the FE renders a
	 * Reddit-style "OP" badge so visitors can tell owner updates from
	 * customer reviews. Server-derived from `User.isFarmOwner`; never a
	 * client-supplied value.
	 */
	isFarmOwner: z.boolean()
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

/** GET /posts/count — public total post tally, used for "See all (N)" copy. */
export const PostCount = z.object({
	count: z.number().int().nonnegative()
});
export type PostCount = z.infer<typeof PostCount>;

/**
 * GET /users/:userId — public-facing profile. The identity card the FE
 * renders when you tap an author from a post/comment. Carries everything
 * needed to draw the procedural avatar (`animal` + `avatarSeed`, varied by
 * `gender`) plus account-age and activity counts. Deliberately omits
 * private fields (email, coin balances) — those live on SessionUser only.
 */
export const PublicProfile = z.object({
	id: z.string(),
	/** Pigweed handle — Better Auth's normalized `username`. */
	username: z.string(),
	gender: Gender,
	animal: Animal,
	avatarSeed: z.number().int(),
	/** ISO timestamp — FE renders "hatched X days ago". */
	createdAt: z.string(),
	/** Non-deleted posts authored. */
	postCount: z.number().int().nonnegative(),
	/** Non-deleted comments authored. */
	commentCount: z.number().int().nonnegative()
});
export type PublicProfile = z.infer<typeof PublicProfile>;

/* ─── Posts ───────────────────────────────────────────────────────── */

export const Post = z.object({
	id: z.string(),
	title: z.string(),
	body: z.string(),
	latitude: z.number(),
	longitude: z.number(),
	/** Coarse place label (town/city) reverse-geocoded at creation; `null` if the lookup failed or is unavailable (old rows). */
	locationName: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	upvoteCount: z.number().int(),
	downvoteCount: z.number().int(),
	/**
	 * Total comments on this post — drives the "N comments" affordance.
	 * Includes soft-deleted comments: the thread renders them as "[deleted]"
	 * stubs (kept for tree integrity), so the badge counts them to match.
	 */
	commentCount: z.number().int().nonnegative(),
	moderated: z.boolean(),
	/** Produce section, or `null` for uncategorized (owner updates / chatter). */
	category: PostCategory.nullable(),
	/** Customer star rating 1–5; `null` when the post isn't a review. */
	rating: z.number().int().min(1).max(5).nullable(),
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
	/** `null` when the viewer sent no lat/lng — the feed is unbounded (all posts, newest-first). */
	radiusKm: z.number().nullable(),
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

/**
 * One row of a user's post-vote history. `postId` is the deep-link
 * target — the FE opens the post straight from it. The embedded `post`
 * carries title/body so the history list renders an inline preview
 * without a second fetch. A post soft-deleted after the vote was cast is
 * redacted: `deletedAt` is non-null, `title`/`body` are `"[deleted]"`,
 * and `author` is null.
 */
export const PostVoteEntry = z.object({
	value: VoteValue,
	postId: z.string(),
	createdAt: z.string(),
	post: z.object({
		title: z.string(),
		body: z.string(),
		createdAt: z.string(),
		updatedAt: z.string(),
		upvoteCount: z.number().int(),
		downvoteCount: z.number().int(),
		/** Non-null once the post is soft-deleted — the row is then redacted. */
		deletedAt: z.string().nullable(),
		author: Author.nullable()
	})
});
export type PostVoteEntry = z.infer<typeof PostVoteEntry>;

/**
 * One row of a user's comment-vote history. `commentId` anchors the
 * comment; `comment.post.id` is the parent post the FE must open to
 * reach it. `body` is supplied for an inline preview (comments have no
 * title). A comment soft-deleted after the vote was cast is redacted:
 * `deletedAt` is non-null, `body` is `"[deleted]"`, and `author` is null.
 */
export const CommentVoteEntry = z.object({
	value: VoteValue,
	commentId: z.string(),
	createdAt: z.string(),
	comment: z.object({
		body: z.string(),
		upvoteCount: z.number().int(),
		downvoteCount: z.number().int(),
		/** Non-null once the comment is soft-deleted — the row is then redacted. */
		deletedAt: z.string().nullable(),
		post: z.object({ id: z.string() }),
		author: Author.nullable()
	})
});
export type CommentVoteEntry = z.infer<typeof CommentVoteEntry>;

/**
 * GET /users/:userId/votes — a user's public vote history. `?target=posts`
 * returns only `postVotes`; `?target=comments` only `commentVotes`; with no
 * target, both arrays are present. Hence each array is optional.
 */
export const UserVotesResponse = z.object({
	postVotes: z.array(PostVoteEntry).optional(),
	commentVotes: z.array(CommentVoteEntry).optional(),
	page: z.number().int(),
	limit: z.number().int()
});
export type UserVotesResponse = z.infer<typeof UserVotesResponse>;

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
	/** Optional produce section (owner updates may omit it). */
	category: PostCategory.optional(),
	/** Optional 1–5 star review rating (owner updates omit it). */
	rating: z.number().int().min(1).max(5).optional(),
	media: z.array(MediaInput).max(MAX_MEDIA_PER_POST).optional()
});
export type PostInput = z.infer<typeof PostInput>;

export const PostPatchInput = z
	.object({
		title: z.string().min(1).max(TITLE_MAX).optional(),
		body: z.string().max(BODY_MAX).optional(),
		/** Pass `null` to clear the category, a value to set it, or omit to leave it. */
		category: PostCategory.nullable().optional(),
		rating: z.number().int().min(1).max(5).nullable().optional()
	})
	.refine(
		(v) =>
			v.title !== undefined ||
			v.body !== undefined ||
			v.category !== undefined ||
			v.rating !== undefined,
		{ message: 'provide at least one of title, body, category, rating' }
	);
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
	/** Moderation categories that tripped (e.g. "hate") — NOT post categories. */
	rejectedCategories: z.array(z.string())
});
export type ContentFlaggedError = z.infer<typeof ContentFlaggedError>;

/** 402 from the granters endpoints when the viewer must pay to unlock. */
export const GrantersLockedError = z.object({
	error: z.string(),
	unlockCoins: z.number().int(),
	unlockEndpoint: z.string()
});
export type GrantersLockedError = z.infer<typeof GrantersLockedError>;
