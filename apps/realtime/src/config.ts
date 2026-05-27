import "dotenv/config";
import { z } from "zod";

/**
 * All env vars in one place. Fail fast at startup if anything is missing
 * or malformed — better than a 3 a.m. NPE in production.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000"),

  OPENAI_API_KEY: z.string().min(1),
  DEEPGRAM_API_KEY: z.string().min(1),
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_VOICE_ID_EN: z.string().default("21m00Tcm4TlvDq8ikWAM"),
  ELEVENLABS_VOICE_ID_DE: z.string().default("pNInz6obpgDQGcFmaJgB"),

  AWS_REGION: z.string().default("eu-central-1"),
  AWS_PROFILE: z.string().optional(),

  /**
   * PostgreSQL connection string.
   *
   *   Local dev:  postgres://vtm:vtm@localhost:5432/vtm
   *   AWS RDS:    postgres://<user>:<pass>@<host>:5432/<db>?sslmode=require
   *
   * The pool auto-detects local vs remote and toggles TLS accordingly.
   */
  DATABASE_URL: z
    .string()
    .url()
    .default("postgres://vtm:vtm@localhost:5432/vtm"),

  COGNITO_USER_POOL_ID: z.string().optional(),
  COGNITO_CLIENT_ID: z.string().optional(),

  ALLOW_ANONYMOUS: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true")
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export const isProd = config.NODE_ENV === "production";
export const isDev = config.NODE_ENV === "development";

/** Comma-separated origin list → array */
export const allowedOrigins = config.ALLOWED_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);
