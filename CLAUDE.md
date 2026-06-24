# pigweed

A backend for a hyperlocal, animal-themed social network — a farm community
(owner updates + customer reviews) with an optional animal pseudonym.

## What pigweed is

Imagine a farm. Every user is an animal — chicken, goose, quail, pig, etc. — assigned randomly when they sign up. You don't choose your animal; you roll for it (re-roll until you like the result, then commit). Your avatar is procedurally drawn from a small library of hand-drawn SVG silhouettes plus deterministic color variations seeded by your user id. You pick a username; you specify a gender.

The farm is **location-bounded**: you only see posts and comments from animals within a radius (~100km) of where you currently are. Travel and the feed travels with you. Each post is locked to the location where it was created, so leaving town doesn't blank the conversation behind you — your old posts stay home.

The vibe is 4chan-flavored anonymity with adult supervision: persistent pseudonym (your animal stays across sessions), bounded community (geo-scoped, not globally exposed), AI moderation gating posts before they land, soft-fading content via community vote thresholds. You can be salty as a goose; you can't be hateful.

> **Update (2026-06): identity is no longer strictly anonymous.** In practice ourlittlefarm is a farm community + reviews: owners post updates (flagged "OP") and customers — the aunties buying eggs — leave reviews, often under their **real names**. The animal/avatar pseudonym is still offered and still the default flavor, but it is **no longer a privacy guarantee**: `username` may be a real name. Read the "never real identity" / "anonymous" language in this doc as historical intent, not a hard constraint — verify before designing a feature around strict anonymity. What still holds: user geo is never stored server-side; IPs are logged for moderation; account age is surfaced; no DMs (harassment vector). Anonymity is now opt-in flavor, not the product's spine.

The visual identity is heavy SVG, GSAP-animated, math-driven. Visual state derives from data state — vote counts make a post card's border grow "bushier," not via stored metadata. Backend stays calm and numeric; the frontend goes feral.

## Principles

1. **Persistent pseudonym beats pure anonymity.** Your animal stays across sessions. The community gets memory; you keep distance from your real identity. _(2026-06: the pseudonym is now optional — many real customers post reviews under their real name. See the Update note above.)_
2. **Bounded community beats global exposure.** Geo radius is the bound. Smaller community = lighter moderation burden, denser local signal.
3. **Moderate hate, not spice.** A grumpy goose calling another goose a fucker is authentic punk-farm energy. Slurs and incitement are not. Use moderation categories (`hate`, `harassment`, `violence`, `self-harm`), not curse-word lists.
4. **Anonymous within the community, never toward an individual.** No anonymous DMs. No "send a message to this specific person" surface, ever. Sarahah and NGL died of this; learn the lesson.
5. **Be honest about what's anonymous.** Posts: public — pseudonymous _or_ real-name, the user's choice (2026-06). IPs: logged for moderation. Account age: surfaced. Tell users this; never trade on a privacy promise you can't keep.
6. **Data state shapes UI state, not the reverse.** Vote counts drive bushiness; downvote thresholds drive collapse; geo distance drives feed inclusion. The backend never embeds visual concepts; the frontend interprets the numbers.

## Identity model

- **Animal**: random assignment at signup (CHICKEN, GOOSE, QUAIL, PIG, DUCK, COW, …). Reroll-as-you-go — every click of "generate" is itself a commit (no save button). The user can re-roll at any time from the settings page; no cooldown for MVP, add one later if we see griefing.
- **Username**: user-chosen, unique. Better Auth currently uses `name` (non-unique); a unique `username` field will need to be added.
- **Gender**: user-chosen at signup. Used to vary avatar drawing and any localized copy.
- **Avatar**: procedurally drawn SVG tile with punk-DNA variation. The image is a _function_, not an asset — `(animal, avatarSeed) → SVG`. The frontend renders from those two fields; no image storage, no CDN, no AI generation. Each avatar tile is a **colored circle (background)** with the **layered animal silhouette** inside it. Both the circle bg and the animal's regions (body, wing, head, accent, accessory) are separate paths with their own `var(--...)` fills. Seed math distributes colors from a curated punk palette across all slots — backgrounds drawn from a saturated/mid-dark sub-palette, bodies from a brighter/contrasting sub-palette so the silhouette never camouflages — plus picks 1-of-N patterns (spots, stripes, scratches) and 0-or-1 accessory (hat, cig, mohawk, etc.). One weekend of hand-drawn iPad work + ~30 lines of seed→CSS-variable code yields effectively infinite distinct avatars per animal type.
- **`avatarSeed`**: random integer column on User, regenerated every time the reroll endpoint is hit. Two users with the same animal but different seeds look visually distinct.
- **Reroll endpoint**: `POST /me/avatar/reroll` — atomically updates `user.animal` and `user.avatarSeed` and returns the new pair. Each click is the commit.
- **Account age**: surfaced as "hatched X days ago" so new accounts are visibly fresh.

## Geo model

- `Post.latitude` / `Post.longitude`: frozen at creation time. The post belongs to a place.
- `User.latitude` / `User.longitude`: mutable. Refreshes from the client or coarse IP-geo on session refresh.
- Feed query filters posts where `distance(post.geo, currentUser.geo) < RADIUS_KM`.
- **PostGIS** is the implementation (Supabase has it; enable via dashboard or `CREATE EXTENSION IF NOT EXISTS postgis;`). Geo columns are `GEOGRAPHY(POINT, 4326)`; queries use `ST_DWithin` with a GIST index for sub-millisecond radius checks.
- Travelling animals see local content where they currently are. Their old posts stay where they were made.
- "Visiting from elsewhere" can be a UI badge later (post.geo far from author's current geo).

## Ranking (algorithm)

A formula, not a model. Until pigweed has 10k+ DAU, ML is overkill. Score signal:

```
score(post, viewer) =
    -k_geo  × distance_km(post, viewer)              // closer is higher
  + k_score × (post.upvoteCount - post.downvoteCount) // votes
  / time_decay(post.createdAt)                        // fresher is higher
  + animal_affinity(post.author.animal, viewer.animal) // chickens see chickens, optional
  + jitter()                                          // small random so top doesn't stick
```

Lives in `src/utils/ranking.ts` (when built). Weights start hard-coded; tune as signal arrives. ML replaces it when the formula stops carrying.

## Moderation

- **Pre-flight**: every post/comment runs through OpenAI Moderation API (free) before insert. Hard-block on categories: `hate`, `hate/threatening`, `harassment`, `harassment/threatening`, `violence/graphic`, `self-harm`, `self-harm/intent`. Allow `sexual/non-explicit` and casual profanity unless the user is reading content as a flagged minor (deferred).
- **Soft-fade via votes**: comments where `upvoteCount - downvoteCount < -5` get `hidden: true` in the response (already shipped). Frontend collapses with click-to-reveal.
- **Reporting (deferred)**: human-review queue keyed by community report counts.
- **No DMs**: harassment vector. Off the roadmap entirely.
- **Vote weight by tenure (deferred)**: new accounts' votes count less. Resists brigading. Defer until brigading actually happens.

## Tech stack

Bun runtime, Hono framework, Better Auth, Prisma 7, Supabase Postgres (with PostGIS), Stripe, Cloudflare R2 (via the `@aws-sdk/client-s3` SDK — R2 is S3-compatible — in `src/utils/storage.ts`, for media), and Redis (`ioredis` → Upstash) for the cross-instance event-bus fan-out in `src/events/bus.ts` (`REDIS_URL` optional; unset = in-process only).

See `memory/project_stack_and_gotchas.md` for the non-obvious traps we've already hit.

## Shipped backend layers

The full backend backbone is done. The FE social layer was built 2026-06-14/16
(feed, create-post, profile posts, live toasts); BE is not yet deployed (next:
Railway — see memory `be-deploy-fe-wiring-checklist`).

> **Update (2026-06) — Post/social additions.** `Post` now has a nullable
> `category` (enum `PostCategory` = EGGS/VEGGIES/FRUITS/ANIMALS) and an optional
> `rating` (Int 1–5, reviews); `User.isFarmOwner` (bool) backs the FE "OP"
> badge (flip manually via Studio/SQL — no admin endpoint). `GET /posts` gained
> `?authorId=` / `?category=` / `?minRating=` filters. Locales are now
> **en/ko/zh/ja** (`zh` = Traditional / zh-TW) across the contract + `i18n.ts`.
> The `CONTENT_FLAGGED` error field is `rejectedCategories` (not `categories`).
> `POST /media` keys objects as `media/<username>/<category>/<id>.webp`.
> Tagged one-line loggers (`[posts]`, `[awards]`, `[achievements]`, `[sse]`, …)
> narrate every state change. Bun.serve sets `idleTimeout: 120` so SSE streams
> survive the 25s heartbeat. All changes go through the contract first (rebuild
> it), and DB migrations are run by the user.

- **Auth** — Better Auth + `username` plugin (validation, login-by-username, `is-username-available`) + `emailOTP` plugin (email verification / password reset / OTP sign-in — `sendVerificationOTP` now sends via the real email layer; with no `RESEND_API_KEY` it falls back to console-logging the code in dev) + `@better-auth/passkey` (WebAuthn) + rate limiting on auth surfaces. `requireEmailVerification` is OFF until the FE has a verify UX.
- **Passkey** — `@better-auth/passkey` plugin. Endpoints: `POST /api/auth/passkey/add-passkey`, `POST /api/auth/sign-in/passkey`, `GET /api/auth/passkey/list-user-passkeys`, `POST /api/auth/passkey/{delete,update}-passkey`. Backed by the `Passkey` Prisma model (shape locked by the plugin — don't add fields it doesn't know about). `rpID` / `rpName` / `origin` come from env (`PASSKEY_RP_ID`, `PASSKEY_RP_NAME`, `PASSKEY_ORIGIN`) with localhost defaults. Prod values bind to `ourlittlefarm.club` — once a passkey is issued against an rpID, changing it orphans the credential, so the apex domain (NOT www.) is the lock-in.
- **i18n** — Hand-rolled typed dict in `src/utils/i18n.ts` (`Locale = 'en'|'ko'`, mirrored in the contract for the FE). Hono middleware in `src/middleware/i18n.ts` parses `Accept-Language` per request and stashes the resolved locale on `c.get('locale')`. Handlers call `t(locale, key)` for user-facing strings. NOT i18next — overkill for the BE's ~5 user-facing strings; swap when the dict grows past ~200 keys or needs ICU pluralization. Known gap: `sendVerificationOTP` runs outside the Hono context, so it currently uses the default locale; plumb when the real Resend send lands.
- **Identity** — `username` (unique), `gender` (enum), `animal` (enum: CHICKEN/DOG/GOOSE), `avatarSeed` (int). Animal+seed server-injected at signup via Better Auth before-create hook (`rollIdentity()` in `src/utils/identity.ts`). `POST /users/me/avatar/reroll` — click-is-commit.
- **Posts, comments, media** — soft-delete + redaction.
- **Coins** — Stripe checkout, webhook crediting.
- **Votes** — UP/DOWN enum, cached counts, public profile votes.
- **Awards** — catalog, multi-grant, granters endpoint gated by pay-to-unlock with `unlockCoins`.
- **`unlockCoins` Postgres trigger** — every 10 awards granted → +5 unlockCoins.
- **Achievements** — DB-driven catalog, in-process event-bus engine, SSE live notifications (`GET /users/me/events`). Metrics: `POSTS_CREATED` / `REVIEWS_CREATED` (a "review" = post with a `rating`) / `COMMENTS_CREATED` / `AWARDS_GRANTED`; `post_created` checks BOTH post + review metrics (a first rated post unlocks First Post AND First Review, each granted/emailed once). Grant logic is the single `grantAchievement()` in `utils/achievements.ts` (atomic insert + coin credit, P2002-idempotent, no email/emit — callers notify); the live engine emails+emits after it, the **`bun run backfill:achievements`** script (reuses `evaluateMetric` + `grantAchievement`) reconciles existing users **silently** (no mail) after adding a new achievement. Public catalog (the "Pokédex"): **`GET /achievements`** lists all active ones; the FE profile "View all achievements" modal cross-refs it against `GET /users/:id/achievements`. (The one-off `backfill:locations` script was removed after use — locations geocode at post creation now.)
- **Visibility threshold** — comments with net score < -5 flagged `hidden`.
- **Geo** — PostGIS on Post only (`geo` generated column from lat/lng, GIST-indexed). User geo NOT stored server-side — FE passes coords per request (privacy + "browse elsewhere"). `POST /posts` requires lat/lng. `GET /posts?lat=&lng=&radius=` filters via `ST_DWithin`.
- **Ranking** — `GET /posts?sort=rank` composite score (geo penalty + time-decayed votes + animal affinity). Default `sort=newest`. Affinity derived server-side from signed-in user (NOT a URL param). Weights tunable in `src/utils/ranking.ts`. Falls back to newest if no geo.
- **AI moderation** — OpenAI `omni-moderation-latest` (free), gates `POST /posts` + `POST /comments` before insert. Hate/threats/self-harm/CSAM/graphic-violence blocked; plain harassment/profanity/non-minor-sexual allowed (the "spice"). Fail-open (missing key / API error / network → allow + log). Hard-reject with 422 `CONTENT_FLAGGED` + human `reason`. Block list tunable in `src/utils/ai/moderator.ts`.
- **Email** — Resend over raw `fetch` (no SDK), fail-open like moderation: no `RESEND_API_KEY` ⇒ `sendEmail()` logs a dry-run and returns `ok:false` instead of throwing, so dev needs no account and a dead provider never tanks a request. Transport in `src/utils/email.ts`; hand-rolled inline-style HTML templates in `src/emails/` (`layout.ts` shell + `templates.ts` functions: `otpEmail`/`welcomeEmail`/`achievementEmail`/`digestEmail`). Two delivery modes:
  - **Real-time** (low-frequency, send-on-event): OTP (Better Auth `sendVerificationOTP`), **welcome** (Better Auth `databaseHooks.user.create.after`), **achievement unlocked** (sent at the grant site in `achievements.ts` — NOT a bus listener, because `achievement_unlocked` is a fan-out event that re-emits per instance under Redis and would double-send).
  - **Daily digest** (high-frequency, batched): comment-on-post / reply / post-upvote / comment-upvote are written as durable `Notification` rows (`recordNotification()` in `src/utils/notifications.ts`, called inline from `comments.ts` + `votes.ts`; self-actions and downvotes excluded). The bus is NOT used — it's lossy and must-survive-til-night. The cron job `src/jobs/send-digests.ts` (`bun run jobs:digest`, Railway Cron `0 9 * * *`) aggregates `emailedAt IS NULL` rows per recipient, sends one email, stamps `emailedAt`. Respects `User.emailDigest`; one-click unsubscribe is the HMAC-signed `GET /email/unsubscribe` (`src/utils/email-token.ts` + `src/routes/email.ts`). Forward-only: existing comments/votes are never back-filled. Copy is English-only for now (digest recipient locale isn't stored — same gap as the OTP locale).
- **Migrations adopted** — versioned `prisma/migrations/`, `bun db:migrate-deploy` auto-materializes the trigger migration. PostGIS setup is a manual-SQL block in the `add_post_geo` migration.

## Not yet built

- **Frontend** — the whole punk SVG/GSAP farm. Backend serves every primitive it needs.
- Procedural SVG avatar rendering (frontend; backend already supplies `animal` + `avatarSeed`).
- "Bushy border" derivation rule (frontend decision).
- Richer animal-affinity ("weight votes by same-species voters") — deferred until simple flat bonus proves insufficient.
- More animals / achievements — seed + enum additions, no architecture.

## Pre-launch hygiene (deferred but real)

- Set `NODE_ENV=production` on the deploy host (Railway is the plan). `src/utils/env.ts:isProd()` keys off it.
- **Real email send** — DONE (Resend, see the **Email** layer above). Remaining prod steps: set `RESEND_API_KEY` + `EMAIL_FROM` on the deploy host, verify the `ourlittlefarm.club` sending domain (SPF/DKIM/DMARC) in Resend, then flip `requireEmailVerification: true`. Add the Railway **Cron** service running `bun run jobs:digest` (e.g. `0 9 * * *`). Still open: plumb the request/recipient locale so OTP + digest bodies localize (needs a `User.locale` column for the digest) instead of defaulting to English.
- **⚠️ Email wiring is a standing requirement.** Any new feature that produces a user-facing event (a new notification type, a new milestone, a billing/state change worth telling someone about) MUST decide its email path: real-time send-on-event (low-frequency → call `sendEmail` with a template at the event site) or batched digest (high-frequency → `recordNotification()` + a section in `digestEmail`/the cron job). Add the template to `src/emails/templates.ts`, respect `User.emailDigest` for anything batched, and keep transactional vs digest separate. Don't ship the event without wiring its email.
- **Passkey prod env** — set `PASSKEY_RP_ID=ourlittlefarm.club`, `PASSKEY_RP_NAME=ourlittlefarm`, `PASSKEY_ORIGIN=https://ourlittlefarm.club` on the deploy host. Apex domain only — `www.ourlittlefarm.club` would issue separate-host passkeys that the apex can't see.
- `OPENAI_API_KEY` set in prod env (moderation fails open without it).
- Stripe live keys + webhook secret separate from dev.
- Privacy notice / TOS — honest about what's logged (IP, timestamps, content) vs. anonymous (no real-name link).
- Age gate (Apple/Google both rate "anonymous social" 17+; pre-emptive).
