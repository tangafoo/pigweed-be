// Single signal for telling dev and prod apart: NODE_ENV. The cross-
// ecosystem convention every JS library reads — set NODE_ENV=production
// on the deployed host (Railway / Fly / etc.); leave unset locally.
//
// As the dev/prod split grows, this is the file to extend (route to
// different Stripe keys, different Better Auth secrets, etc.).

export function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

// Browser origins allowed to make credentialed requests. Drives BOTH the
// CORS middleware and Better Auth's trustedOrigins (CSRF allow-list), so
// they can never disagree. Comma-separated; dev defaults to the
// SvelteKit dev server. In prod set CORS_ORIGIN to the deployed FE URL
// (e.g. https://ourlittlefarm.club) — a one-line env change, no code.
export function allowedOrigins(): string[] {
  return (process.env.CORS_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

// ─── Passkey / WebAuthn config ─────────────────────────────────────
// rpID is the DNS effective-domain the browser binds passkeys to: it
// MUST match the FE host exactly (no scheme, no port) — `localhost`
// in dev, `ourlittlefarm.club` in prod. rpName is the human-readable
// label browsers show in the credential prompt. `origin` is the full
// scheme+host(+port) of the FE, used for origin checks in the BA
// passkey plugin's verification step.
export function passkeyRpId(): string {
  return process.env.PASSKEY_RP_ID ?? "localhost";
}

export function passkeyRpName(): string {
  // Default is the PUBLIC brand ("ourlittlefarm"), not the internal
  // codename ("pigweed"), because this string surfaces in the OS
  // credential prompt ("Use a passkey for <PASSKEY_RP_NAME>?") even in
  // local dev. See memory: brand-pigweed-internal-ourlittlefarm-public.
  return process.env.PASSKEY_RP_NAME ?? "ourlittlefarm";
}

export function passkeyOrigin(): string {
  return process.env.PASSKEY_ORIGIN ?? "http://localhost:5173";
}
