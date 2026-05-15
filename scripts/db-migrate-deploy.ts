import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Wraps `prisma migrate deploy` so that any SQL files in prisma/triggers/
// get materialized as a versioned Prisma migration the first time this
// runs. Idempotent — subsequent runs see the existing migration and skip.
//
// Why this exists: Prisma does not manage Postgres triggers natively, so
// they live in hand-written migrations. Without this wrapper you'd have
// to manually `prisma migrate dev --create-only` and copy the SQL across
// every time you start a new dev environment. This puts it on autopilot.
//
// If you ever NEED TO CHANGE a trigger (the SQL in prisma/triggers/X.sql
// changes), this script does NOT regenerate the migration — applied
// migrations are immutable. Create a new migration with the DROP+CREATE
// SQL manually:
//   bunx prisma migrate dev --create-only --name update_triggers

const TRIGGERS_DIR = "prisma/triggers";
const MIGRATIONS_DIR = "prisma/migrations";
const TRIGGER_MIGRATION_SUFFIX = "_triggers";

// Prisma's migration folder convention: 14-digit UTC timestamp + "_" + name
function newTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

function existingTriggerMigration(): string | null {
  if (!existsSync(MIGRATIONS_DIR)) return null;
  const match = readdirSync(MIGRATIONS_DIR).find((d) =>
    d.endsWith(TRIGGER_MIGRATION_SUFFIX),
  );
  return match ? `${MIGRATIONS_DIR}/${match}` : null;
}

function bundleTriggerSql(): string {
  if (!existsSync(TRIGGERS_DIR)) return "";
  const files = readdirSync(TRIGGERS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) return "";
  // Each file is concatenated with a comment marker so the produced
  // migration is readable / git-diffable in case you ever debug it.
  return files
    .map((f) => `-- from ${TRIGGERS_DIR}/${f}\n${readFileSync(`${TRIGGERS_DIR}/${f}`, "utf8")}`)
    .join("\n\n");
}

// Step 1 — materialize the trigger migration if it isn't already on disk.
const existing = existingTriggerMigration();
if (existing) {
  console.log(`✓ Trigger migration already exists: ${existing}`);
} else {
  const sql = bundleTriggerSql();
  if (sql.trim().length === 0) {
    console.log("• No SQL files in prisma/triggers/ — nothing to materialize.");
  } else {
    const dir = `${MIGRATIONS_DIR}/${newTimestamp()}${TRIGGER_MIGRATION_SUFFIX}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/migration.sql`, sql);
    console.log(`✓ Materialized trigger migration: ${dir}/migration.sql`);
  }
}

// Step 2 — apply every pending migration (the trigger one plus any others).
console.log("\nApplying pending migrations...\n");
const result = spawnSync("bunx", ["prisma", "migrate", "deploy"], { stdio: "inherit" });
process.exit(result.status ?? 0);
