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
// (e.g. https://pigweed.app) — a one-line env change, no code.
export function allowedOrigins(): string[] {
  return (process.env.CORS_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}
