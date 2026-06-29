// ─────────────────────────────────────────────────────────────
// DB BACKUP JOB — standalone script, run by Railway cron (NOT the web
// process). Every 3 days it:
//   1. runs `pg_dump` on DATABASE_URL (custom format, compressed),
//   2. uploads the dump to R2 under backups/olf-<ISO>.dump,
//   3. prunes dumps older than RETENTION_DAYS.
//
// Run locally:  bun run jobs:backup
// Railway:      add a Cron service with the start command `bun run jobs:backup`
//               and a schedule like `0 3 */3 * *` (03:00 UTC, every 3rd day).
//
// REQUIRES the `pg_dump` binary on PATH, matching Supabase's Postgres major
// version (add `postgresql-client` to the Railway image via nixpacks aptPkgs
// or a Dockerfile; install locally too). R2 must be configured.
//
// Restore a dump with:  pg_restore --clean --if-exists -d "$DATABASE_URL" olf-….dump
// ─────────────────────────────────────────────────────────────

import { databaseUrl } from "../utils/env";
import { isStorageConfigured, putObject, listObjects, deleteObject } from "../utils/storage";

const PREFIX = "backups/";
const RETENTION_DAYS = 30;

async function main() {
  if (!isStorageConfigured()) {
    console.error("[backup] R2 is not configured — aborting (no destination for the dump).");
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const key = `${PREFIX}olf-${stamp}.dump`;

  // `pg_dump -Fc` = custom format (compressed, restorable with pg_restore).
  console.log(`[backup] running pg_dump → ${key}`);
  const proc = Bun.spawn(["pg_dump", "-Fc", "--no-owner", "--no-acl", databaseUrl()], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [dump, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    console.error(`[backup] pg_dump failed (exit ${exitCode}):\n${stderr}`);
    process.exit(1);
  }
  if (dump.byteLength === 0) {
    console.error("[backup] pg_dump produced an empty file — aborting.");
    process.exit(1);
  }

  await putObject(key, new Uint8Array(dump), "application/octet-stream");
  console.log(`[backup] uploaded ${(dump.byteLength / 1024 / 1024).toFixed(2)} MB → ${key}`);

  // Prune dumps older than the retention window.
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const existing = await listObjects(PREFIX);
  const stale = existing.filter((o) => o.lastModified.getTime() < cutoff);
  for (const o of stale) {
    await deleteObject(o.key);
    console.log(`[backup] pruned old dump ${o.key}`);
  }
  console.log(`[backup] done — ${existing.length - stale.length + 1} dump(s) retained.`);
}

main().catch((err) => {
  console.error("[backup] fatal:", err);
  process.exit(1);
});
