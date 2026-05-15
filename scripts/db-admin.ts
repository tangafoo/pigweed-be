import { spawnSync } from "node:child_process";

// One-stop admin CLI. Subcommands:
//   bun db:count   → row counts per table

function execSql(sql: string): void {
    // Prisma 7: `db execute` reads its config from prisma.config.ts, so the
    // legacy --schema flag is rejected. Just pipe SQL through --stdin.
    const result = spawnSync(
        "bunx",
        ["prisma", "db", "execute", "--stdin"],
        { input: sql, stdio: ["pipe", "inherit", "inherit"] },
    );
    if (result.status !== 0) process.exit(result.status ?? 1);
}

const subcommand = process.argv[2];

if (subcommand === "count") {
    // No prod refusal — counting is read-only, safe everywhere.
    const tables = [
        "user", "session", "account", "verification",
        "post", "post_media", "comment",
        "post_vote", "comment_vote",
        "coin_pack", "coin_purchase",
        "award_type", "post_award", "comment_award",
        "post_granters_unlock", "comment_granters_unlock",
        "achievement", "user_achievement",
    ];
    const unions = tables
        .map((t) => `SELECT '${t}' AS table_name, COUNT(*) AS rows FROM "${t}"`)
        .join(" UNION ALL ");
    execSql(`${unions} ORDER BY table_name;`);
} else {
    console.error('Unknown subcommand. Use: count');
    process.exit(1);
}
