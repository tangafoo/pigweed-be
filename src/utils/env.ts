// Single signal for telling dev and prod apart: NODE_ENV. The cross-
// ecosystem convention every JS library reads — set NODE_ENV=production
// on the deployed host (Railway / Fly / etc.); leave unset locally.
//
// As the dev/prod split grows, this is the file to extend (route to
// different Stripe keys, different Better Auth secrets, etc.).

export function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}
