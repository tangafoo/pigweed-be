import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// ENVIRONMENT — single validated source of truth.
//
// Every env var the BE reads is declared in ONE Zod schema and parsed
// ONCE at module load. Benefits over scattered `process.env.X ?? default`
// reads: (1) fail-fast — a missing/blank required var stops the process at
// boot with a clear message, not lazily at request time; (2) one place to
// see the whole contract; (3) cross-field rules (the R2 "all-5-or-none"
// group) are declarative instead of an `&&` chain.
//
// Multi-service note: every service (the API server AND the cron jobs:
// digest / subscription-deliveries / backup) runs THIS repo, and anything
// touching Prisma imports utils/db → this file. So the ONLY var required at
// import is DATABASE_URL — the one thing all of them genuinely need. The
// web-only secrets (BETTER_AUTH_SECRET, STRIPE_SECRET_KEY) are OPTIONAL in
// the schema and enforced separately by assertWebEnv(), called ONLY from the
// API server's entrypoint (src/index.ts). That keeps the cron services at
// least-privilege — they boot on just the handful of vars they actually use
// and never carry auth/Stripe keys. REDIS_URL and the R2 group stay optional
// (bus falls back to in-process; uploads 503). assertWebEnv keeps the API
// server's fail-fast.
// ─────────────────────────────────────────────────────────────

const R2_KEYS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_BASE_URL",
] as const;

const schema = z
  .object({
    NODE_ENV: z.string().optional(),

    // Comma-separated browser origins for CORS + Better Auth trustedOrigins.
    CORS_ORIGIN: z.string().default("http://localhost:5173"),

    // Runtime DB connection (Prisma pg adapter). DIRECT_URL is CLI-only
    // (migrations) so it's optional at runtime.
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    DIRECT_URL: z.string().optional(),

    // Web-only secret — OPTIONAL here so cron jobs boot without it; enforced
    // for the API server by assertWebEnv(). (Better Auth also reads it directly
    // from process.env on the web service.)
    BETTER_AUTH_SECRET: z.string().optional(),
    BETTER_AUTH_URL: z.string().default("http://localhost:3000"),

    PASSKEY_RP_ID: z.string().default("localhost"),
    PASSKEY_RP_NAME: z.string().default("ourlittlefarm"),
    PASSKEY_ORIGIN: z.string().default("http://localhost:5173"),

    // Web-only — OPTIONAL here, enforced by assertWebEnv(). Stripe code paths
    // (utils/stripe.ts) are imported only by the API server, never the crons.
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().default(""),

    // Moderation fails OPEN without this — optional on purpose.
    OPENAI_API_KEY: z.string().optional(),

    // Transactional + digest email (Resend). Optional: with no key, the
    // email layer fails OPEN and console.logs the message instead of
    // sending (same dev posture as OPENAI_API_KEY / the OTP console.log).
    // EMAIL_FROM is the verified sender on the ourlittlefarm.club domain.
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default("ourlittlefarm <no-reply@ourlittlefarm.club>"),

    // Secret that signs one-click unsubscribe links (HMAC). Kept SEPARATE from
    // BETTER_AUTH_SECRET so the digest cron can sign links WITHOUT carrying the
    // auth secret. Falls back to BETTER_AUTH_SECRET if unset (back-compat for
    // single-secret deploys). Set the SAME value on the web + digest services.
    EMAIL_TOKEN_SECRET: z.string().optional(),

    // Absolute URL of the brand logo shown in every email header. Must be a
    // publicly-reachable raster (PNG/JPEG) — email clients fetch it over HTTP
    // and refuse SVG/WebP. Lives in the ourlittlefarm-assets R2 bucket; swap
    // the file (same key) or repoint this var to change it everywhere.
    EMAIL_LOGO_URL: z
      .string()
      .default("https://media.ourlittlefarm.club/olf-logo.png"),

    // Where the contact / "egg feedback" form delivers (the boss's inbox).
    FEEDBACK_TO: z.string().default("leeminjacque@gmail.com"),

    // Cross-instance event-bus transport. Unset ⇒ pure in-process.
    REDIS_URL: z.string().optional(),

    // Media storage (Cloudflare R2). Each optional individually; the
    // superRefine below enforces all-or-nothing as a group.
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    R2_PUBLIC_BASE_URL: z.string().optional(),

    // Separate PRIVATE bucket for DB backups (no public domain). Falls back to
    // R2_BUCKET if unset, but DON'T do that in prod — the assets bucket is
    // public, and a DB dump must never be publicly downloadable. Set this on
    // the backup service only. Uses the same R2 account creds as R2_*.
    R2_BACKUP_BUCKET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // "These five travel together." Partial R2 config is almost always a
    // copy-paste mistake — fail loudly at boot rather than 503-ing later.
    const present = R2_KEYS.filter((k) => env[k]);
    if (present.length > 0 && present.length < R2_KEYS.length) {
      const missing = R2_KEYS.filter((k) => !env[k]);
      ctx.addIssue({
        code: "custom",
        message: `R2 is partially configured — missing: ${missing.join(", ")}. Set all five or none.`,
      });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Build one string and write it synchronously to stderr. A bare throw at
  // import time can be killed by the host (Railway) before async log shipping
  // flushes the last lines — so the crash looks silent. Write it as a single
  // blocking write, then exit explicitly with a non-zero code.
  const lines = [
    "❌ [env] Invalid environment configuration — refusing to boot:",
    ...parsed.error.issues.map(
      (issue) => `  • ${issue.path.join(".") || "(env)"}: ${issue.message}`,
    ),
    "Set these in the Railway service Variables panel, then redeploy.",
    "",
  ];
  process.stderr.write(lines.join("\n"));
  process.exit(1);
}

// Validated, typed env. Accessors below read from this, never process.env.
const env = parsed.data;

export function isProd(): boolean {
  return env.NODE_ENV === "production";
}

// Boot-time guard for the API SERVER only (called from src/index.ts) — NOT by
// the cron jobs, so they boot at least-privilege. Keeps the web server's
// fail-fast: a missing auth/Stripe secret stops it cleanly at boot with a
// clear message instead of a lazy mid-request throw.
export function assertWebEnv(): void {
  const missing: string[] = [];
  if (!env.BETTER_AUTH_SECRET) missing.push("BETTER_AUTH_SECRET");
  if (!env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  if (missing.length > 0) {
    process.stderr.write(
      `❌ [env] API server is missing required vars: ${missing.join(", ")}. ` +
        `Set them on the web service, then redeploy.\n`,
    );
    process.exit(1);
  }
}

// Secret for unsubscribe-link HMACs. Prefers the dedicated EMAIL_TOKEN_SECRET;
// falls back to BETTER_AUTH_SECRET so single-secret deploys keep working. Set
// EMAIL_TOKEN_SECRET on web + digest to keep BETTER_AUTH_SECRET off the crons.
export function emailTokenSecret(): string {
  return env.EMAIL_TOKEN_SECRET || env.BETTER_AUTH_SECRET || "";
}

// Browser origins allowed to make credentialed requests. Drives BOTH the
// CORS middleware and Better Auth's trustedOrigins (CSRF allow-list), so
// they can never disagree.
export function allowedOrigins(): string[] {
  return env.CORS_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

export function databaseUrl(): string {
  return env.DATABASE_URL;
}

// The PRIVATE bucket DB dumps are written to (backup job). Falls back to the
// public R2_BUCKET if unset — fine for local dev, NOT for prod (dumps would be
// publicly downloadable). Returns undefined only if neither is set.
export function backupBucket(): string | undefined {
  return env.R2_BACKUP_BUCKET || env.R2_BUCKET;
}

// The connection string `pg_dump` should use (backup job). DATABASE_URL is the
// Supabase TRANSACTION pooler (:6543 + ?pgbouncer=true) — pg_dump can't use it:
// libpq rejects the `pgbouncer` param, and a transaction pooler can't give a
// consistent dump snapshot. So we derive the SESSION pooler from it: same host,
// port 6543→5432, drop the Prisma-only query params. We intentionally do NOT
// fall back to DIRECT_URL — Supabase's direct host is IPv6-only and Railway is
// IPv4, so the derived (IPv4) session pooler is the only thing that connects.
export function ipv4DatabaseUrl(): string {
  try {
    const u = new URL(env.DATABASE_URL);
    u.searchParams.delete("pgbouncer");
    u.searchParams.delete("connection_limit");
    if (u.port === "6543") u.port = "5432"; // transaction pooler → session pooler
    return u.toString();
  } catch {
    return env.DATABASE_URL;
  }
}

// Public FE base URL — where email "Open the farm" buttons point. The FE
// is the first CORS origin (prod: https://ourlittlefarm.club). Falls back
// to the prod domain if CORS_ORIGIN is somehow empty.
export function appUrl(): string {
  return (allowedOrigins()[0] ?? "https://ourlittlefarm.club").replace(/\/+$/, "");
}

export function betterAuthUrl(): string {
  return env.BETTER_AUTH_URL;
}

// ─── Passkey / WebAuthn config ─────────────────────────────────────
// rpID is the DNS effective-domain the browser binds passkeys to: it MUST
// match the FE host exactly (no scheme, no port). rpName is the human label
// in the credential prompt — the PUBLIC brand "ourlittlefarm", not the
// "pigweed" codename (see memory: brand-pigweed-internal-ourlittlefarm-public).
// origin is the full scheme+host(+port) used in the BA passkey verification.
export function passkeyRpId(): string {
  return env.PASSKEY_RP_ID;
}

export function passkeyRpName(): string {
  return env.PASSKEY_RP_NAME;
}

export function passkeyOrigin(): string {
  return env.PASSKEY_ORIGIN;
}

export function stripeSecretKey(): string {
  // Optional in the schema (cron jobs don't need it); this accessor lives on
  // web-only code paths, so a missing value here is a real misconfiguration.
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  return env.STRIPE_SECRET_KEY;
}

export function stripeWebhookSecret(): string {
  return env.STRIPE_WEBHOOK_SECRET;
}

export function openaiApiKey(): string | undefined {
  return env.OPENAI_API_KEY;
}

// ─── Email (Resend) ────────────────────────────────────────────────
// Unset key ⇒ email fails open (logs instead of sends), so dev needs no
// account. emailFrom is always defined (has a default). The unsubscribe
// link in digest emails points back at the BE host (betterAuthUrl), which
// serves GET /email/unsubscribe.
export function resendApiKey(): string | undefined {
  return env.RESEND_API_KEY;
}

export function emailFrom(): string {
  return env.EMAIL_FROM;
}

// Absolute URL of the brand logo embedded in every email header (see schema).
export function emailLogoUrl(): string {
  return env.EMAIL_LOGO_URL;
}

// Recipient inbox for the contact / feedback form.
export function feedbackTo(): string {
  return env.FEEDBACK_TO;
}

// Backs the cross-instance fan-out of the event bus (src/events/bus.ts).
// Unset ⇒ in-process only. Upstash gives a rediss:// (TLS) URL — ioredis
// enables TLS automatically from the scheme.
export function redisUrl(): string | undefined {
  return env.REDIS_URL;
}

// ─── Media storage (Cloudflare R2) ─────────────────────────────────
// publicBaseUrl is the read-side front door (r2.dev URL or custom domain);
// the keys are the write-side back door used only by the BE. The schema
// guarantees the five vars are all-present-or-all-absent, so this is null
// (uploads disabled) or a complete config — never partial.
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
}

export function r2Config(): R2Config | null {
  if (!env.R2_ACCOUNT_ID) return null; // group is all-or-none (see superRefine)
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    bucket: env.R2_BUCKET!,
    // Trailing slash trimmed so `${publicBaseUrl}/${key}` never doubles up.
    publicBaseUrl: env.R2_PUBLIC_BASE_URL!.replace(/\/+$/, ""),
  };
}
