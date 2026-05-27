/**
 * PostgreSQL connection pool + Drizzle client.
 *
 * One pool per Node process. The default `pg` pool config (max 10 conns,
 * 10s idle timeout) is fine for our footprint; bump `max` if we ever serve
 * thousands of concurrent WebSocket sessions per instance.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import * as schema from "./schema.js";

const isLocal = /localhost|127\.0\.0\.1|host\.docker\.internal/.test(
  config.DATABASE_URL
);

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  // RDS in eu-central-1 requires TLS; local Postgres doesn't.
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 8_000
});

pool.on("error", (err) => {
  // Idle-client errors shouldn't crash the process — they're transient
  // network blips. Pool will reconnect on next checkout.
  logger.error({ err }, "Postgres idle client error");
});

export const db = drizzle(pool, { schema });

export type DB = typeof db;

logger.info(
  {
    host: maskedHost(config.DATABASE_URL),
    ssl: !isLocal
  },
  "Postgres pool initialized"
);

function maskedHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}/${u.pathname.slice(1)}`;
  } catch {
    return "<invalid>";
  }
}

/** Graceful shutdown — call from SIGTERM/SIGINT handlers. */
export async function closePool(): Promise<void> {
  await pool.end();
}
