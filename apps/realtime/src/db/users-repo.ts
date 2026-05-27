import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { type DbUser, users } from "./schema.js";
import { logger } from "../utils/logger.js";

/**
 * Identity gateway. Every entrypoint (WebSocket hello, REST request) funnels
 * through `upsertUserFromIdentity` to convert an external identity claim
 * into our internal users.id.
 *
 * Why upsert on every entry: makes the system self-healing. A new Cognito
 * user signing in for the first time gets a row created. A returning user
 * gets `last_active_at` bumped and profile fields refreshed if Cognito has
 * newer email/name.
 */

export interface ExternalIdentity {
  /** "cognito:<sub>" or "anon:<uuid>" */
  externalId: string;
  email?: string;
  name?: string;
  isAnonymous: boolean;
}

/**
 * Look up or create the user row for this external identity.
 * Returns the internal users.id (a UUID) — that's what tasks.user_id stores.
 */
export async function upsertUserFromIdentity(
  identity: ExternalIdentity
): Promise<DbUser> {
  const now = new Date();
  const [row] = await db
    .insert(users)
    .values({
      externalId: identity.externalId,
      email: identity.email,
      name: identity.name,
      isAnonymous: identity.isAnonymous,
      createdAt: now,
      lastActiveAt: now
    })
    .onConflictDoUpdate({
      target: users.externalId,
      // Only refresh fields if we got new values. Don't overwrite a known
      // name/email with undefined just because a later WS hello forgot to
      // send them.
      set: {
        lastActiveAt: now,
        ...(identity.email !== undefined ? { email: identity.email } : {}),
        ...(identity.name !== undefined ? { name: identity.name } : {})
      }
    })
    .returning();

  if (!row) {
    throw new Error("upsertUserFromIdentity returned no row");
  }
  return row;
}

export async function getUserById(id: string): Promise<DbUser | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

/**
 * Used when migrating an anonymous user to a Cognito user later. Out of scope
 * for the assessment but the FK design supports it cleanly: update users row's
 * external_id from "anon:<uuid>" to "cognito:<sub>", and every task's
 * user_id keeps pointing at the same row.
 */
export async function relinkExternalId(
  internalUserId: string,
  newExternalId: string,
  newProfile: { email?: string; name?: string }
): Promise<void> {
  await db
    .update(users)
    .set({
      externalId: newExternalId,
      isAnonymous: false,
      email: newProfile.email,
      name: newProfile.name,
      lastActiveAt: new Date()
    })
    .where(eq(users.id, internalUserId));
  logger.info({ internalUserId, newExternalId }, "User identity relinked");
}
