import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config — used by `pnpm db:push`, `db:generate`, `db:studio`.
 *
 * For local dev we use `db:push` (sync schema directly, no migration files).
 * For production we generate SQL migrations into `./drizzle/` and apply
 * them on EC2 startup via the deploy script.
 */
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ?? "postgres://vtm:vtm@localhost:5432/vtm"
  },
  strict: true,
  verbose: true
});
