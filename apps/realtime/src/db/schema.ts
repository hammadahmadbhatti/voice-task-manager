/**
 * Drizzle schema — single source of truth for the PostgreSQL database.
 *
 * Two tables:
 *
 *   users           One row per identity. Cognito users have
 *                   external_id = "cognito:<sub>" so multiple logins by the
 *                   same Cognito user collapse to one row. Anonymous users
 *                   get external_id = "anon:<client-uuid>" — the UUID lives
 *                   in the browser's localStorage, so re-opening the tab
 *                   resumes the same anonymous account.
 *
 *   tasks           CRUD targets, FK to users.id with ON DELETE CASCADE.
 *                   Indexed on (user_id, scheduled_at) for the most common
 *                   query: "give me this user's tasks in a time window."
 *
 * Why a separate internal id (uuid) instead of using external_id directly as
 * the PK: it's stable across identity transitions. If we ever migrate an
 * anonymous user to a Cognito user (after they sign up), we update
 * external_id but tasks keep their existing user_id FK.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Canonical identity key. Either:
     *   "cognito:<sub>"  for authenticated users
     *   "anon:<uuid>"    for anonymous users (UUID stable in localStorage)
     */
    externalId: text("external_id").notNull(),
    email: text("email"),
    name: text("name"),
    isAnonymous: boolean("is_anonymous").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (t) => ({
    externalIdUniq: uniqueIndex("users_external_id_uniq").on(t.externalId)
  })
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    /** Always UTC; the originating timezone is on `timezone` */
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    /** "pending" | "done" | "cancelled" — enforced by app, not DB */
    status: text("status").notNull().default("pending"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
  },
  (t) => ({
    userScheduledIdx: index("tasks_user_scheduled_idx").on(
      t.userId,
      t.scheduledAt
    ),
    userStatusIdx: index("tasks_user_status_idx").on(
      t.userId,
      t.status,
      t.scheduledAt
    )
  })
);

export type DbUser = typeof users.$inferSelect;
export type DbTask = typeof tasks.$inferSelect;
export type NewDbTask = typeof tasks.$inferInsert;
