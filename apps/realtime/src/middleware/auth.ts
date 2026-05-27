import { CognitoJwtVerifier } from "aws-jwt-verify";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Verifies Cognito-issued ID tokens against the User Pool's JWKS, then
 * returns a normalized identity payload. The CALLER is responsible for
 * passing this to `upsertUserFromIdentity` to convert it into the
 * internal users.id used for FKs.
 *
 * Anonymous flow (when ALLOW_ANONYMOUS=true):
 *   - Client passes a stable UUID stored in localStorage.
 *   - We accept it and produce externalId = "anon:<uuid>".
 *   - Same UUID across WebSocket + REST requests → same DB user.
 */

export interface VerifiedIdentity {
  /** Canonical external identity. "cognito:<sub>" or "anon:<uuid>". */
  externalId: string;
  email?: string;
  name?: string;
  isAnonymous: boolean;
}

let verifier:
  | ReturnType<
      typeof CognitoJwtVerifier.create<{
        userPoolId: string;
        tokenUse: "id";
        clientId: string;
      }>
    >
  | null = null;

if (config.COGNITO_USER_POOL_ID && config.COGNITO_CLIENT_ID) {
  verifier = CognitoJwtVerifier.create({
    userPoolId: config.COGNITO_USER_POOL_ID,
    tokenUse: "id",
    clientId: config.COGNITO_CLIENT_ID
  });
  logger.info(
    { pool: config.COGNITO_USER_POOL_ID },
    "Cognito JWT verifier initialized"
  );
} else if (!config.ALLOW_ANONYMOUS) {
  logger.warn(
    "Cognito env vars are not set and ALLOW_ANONYMOUS=false — all auth will fail. Set ALLOW_ANONYMOUS=true for local dev."
  );
}

export async function verifyIdToken(
  idToken: string | null,
  /** Stable anonymous ID from the client (UUID v4). Used only if idToken is null. */
  anonId: string | null
): Promise<VerifiedIdentity> {
  // Authenticated path
  if (idToken) {
    if (!verifier) {
      if (config.ALLOW_ANONYMOUS) {
        logger.warn(
          "Token provided but Cognito not configured; treating as anonymous"
        );
        return makeAnonIdentity(anonId);
      }
      throw new AuthError("cognito_not_configured", "Server has no Cognito config");
    }
    try {
      const payload = await verifier.verify(idToken);
      const sub = String(payload.sub);
      const email =
        typeof payload.email === "string" ? (payload.email as string) : undefined;
      const name =
        typeof payload.name === "string"
          ? (payload.name as string)
          : typeof payload["cognito:username"] === "string"
            ? (payload["cognito:username"] as string)
            : undefined;
      return {
        externalId: `cognito:${sub}`,
        email,
        name,
        isAnonymous: false
      };
    } catch (err) {
      logger.warn({ err }, "Token verification failed");
      throw new AuthError("invalid_token", "ID token failed verification");
    }
  }

  // Anonymous path
  if (!config.ALLOW_ANONYMOUS) {
    throw new AuthError("missing_token", "No ID token provided");
  }
  return makeAnonIdentity(anonId);
}

function makeAnonIdentity(anonId: string | null): VerifiedIdentity {
  // If the client forgot to send an anonId, fall back to a random one for
  // this request. That breaks WS<>REST consistency for this single request,
  // but it's better than rejecting the whole connection. The frontend always
  // sends an anonId from localStorage, so this branch is a safety net.
  const id = isValidUuid(anonId) ? anonId! : randomFallback();
  return {
    externalId: `anon:${id}`,
    isAnonymous: true
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s: string | null): s is string {
  return Boolean(s && UUID_RE.test(s));
}

function randomFallback(): string {
  // Don't use crypto.randomUUID here for Node 18 compat — but pg/crypto is
  // available. Use a quick non-secure UUID v4 generator.
  return "00000000-0000-4000-8000-" + Math.random().toString(16).slice(2, 14).padEnd(12, "0");
}

export class AuthError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}
