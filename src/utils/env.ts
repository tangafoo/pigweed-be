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
// Required vs optional mirrors real boot semantics: the app genuinely
// can't run without DATABASE_URL / BETTER_AUTH_SECRET / STRIPE_SECRET_KEY,
// so those are required. REDIS_URL and the R2 group are OPTIONAL by design
// — the bus falls back to in-process and uploads return 503 — so they stay
// optional here too. (BETTER_AUTH_SECRET / BETTER_AUTH_URL are also read
// directly by the Better Auth library from process.env; we validate them
// without taking over that read.)
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

    BETTER_AUTH_SECRET: z.string().min(1, "BETTER_AUTH_SECRET is required"),
    BETTER_AUTH_URL: z.string().default("http://localhost:3000"),

    PASSKEY_RP_ID: z.string().default("localhost"),
    PASSKEY_RP_NAME: z.string().default("ourlittlefarm"),
    PASSKEY_ORIGIN: z.string().default("http://localhost:5173"),

    STRIPE_SECRET_KEY: z.string().min(1, "STRIPE_SECRET_KEY is required"),
    STRIPE_WEBHOOK_SECRET: z.string().default(""),

    // Moderation fails OPEN without this — optional on purpose.
    OPENAI_API_KEY: z.string().optional(),

    // Cross-instance event-bus transport. Unset ⇒ pure in-process.
    REDIS_URL: z.string().optional(),

    // Media storage (Cloudflare R2). Each optional individually; the
    // superRefine below enforces all-or-nothing as a group.
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    R2_PUBLIC_BASE_URL: z.string().optional(),
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
  return env.STRIPE_SECRET_KEY;
}

export function stripeWebhookSecret(): string {
  return env.STRIPE_WEBHOOK_SECRET;
}

export function openaiApiKey(): string | undefined {
  return env.OPENAI_API_KEY;
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
