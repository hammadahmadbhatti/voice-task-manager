/**
 * Local-dev convenience script:
 *
 *   1. Wait for the postgres container to be ready
 *   2. Apply schema via drizzle-kit push (idempotent)
 *
 * In production we ship generated SQL migrations and apply them on
 * EC2 startup — but for the inner-loop, `db:push` is faster and avoids
 * a migration-file commit on every schema tweak.
 *
 * Run:
 *   docker compose up -d
 *   pnpm --filter @vtm/realtime exec tsx scripts/setup-local-db.ts
 */

import "dotenv/config";
import { Pool } from "pg";
import { execSync } from "node:child_process";

const url =
  process.env.DATABASE_URL ?? "postgres://vtm:vtm@localhost:5432/vtm";

async function waitForPostgres(maxAttempts = 30): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1500 });
      const client = await pool.connect();
      await client.query("SELECT 1");
      client.release();
      await pool.end();
      console.log(`✓ Postgres ready (attempt ${i})`);
      return;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stdout.write(`  ⏳ waiting for postgres (${i}/${maxAttempts}) — ${detail}\r`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Postgres at ${url} did not become ready in time`);
}

async function main(): Promise<void> {
  console.log(`→ Target: ${url}`);
  await waitForPostgres();

  console.log("→ Applying schema via drizzle-kit push…");
  execSync("npx drizzle-kit push --verbose", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url }
  });
  console.log("✓ Schema applied");
}

main().catch((err) => {
  console.error("✗ setup failed:", err);
  process.exit(1);
});
