"use client";

/**
 * Cognito Hosted UI authentication using OAuth2 Authorization Code +
 * PKCE flow. Why this and not Amplify:
 *   - One file, ~150 lines, easy to audit
 *   - No Amplify bundle bloat (~250 KB saved)
 *   - We only need ID-token-for-WS-auth; no AWS SDK calls from the client
 *
 * Tokens are stored in sessionStorage (cleared on tab close) — adequate
 * for this demo. For real prod, prefer httpOnly cookies via a server-side
 * token exchange (Next.js Route Handler) to avoid XSS exposure.
 */

const STORAGE_KEY = "vtm:auth";

interface StoredTokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export function getStoredTokens(): StoredTokens | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredTokens;
    if (parsed.expiresAt < Date.now()) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setStoredTokens(tokens: StoredTokens): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

export function clearTokens(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function isAuthenticated(): boolean {
  return getStoredTokens() !== null;
}

// ---------- OAuth flow ----------

const DOMAIN = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? "";
const CLIENT_ID = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "";
const REDIRECT_URI =
  process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI ??
  (typeof window !== "undefined" ? `${window.location.origin}/auth/callback` : "");

export function isCognitoConfigured(): boolean {
  return Boolean(DOMAIN && CLIENT_ID);
}

export async function startSignIn(provider?: "Google"): Promise<void> {
  if (!isCognitoConfigured()) {
    throw new Error("Cognito is not configured (check NEXT_PUBLIC_COGNITO_*)");
  }
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  sessionStorage.setItem("vtm:pkce", codeVerifier);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid email profile",
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });
  if (provider) params.set("identity_provider", provider);

  window.location.href = `https://${DOMAIN}/oauth2/authorize?${params}`;
}

export async function completeSignIn(code: string): Promise<StoredTokens> {
  const verifier = sessionStorage.getItem("vtm:pkce");
  if (!verifier) throw new Error("Missing PKCE verifier in session");

  const res = await fetch(`https://${DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  const tokens: StoredTokens = {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000 - 30_000 // 30 s safety margin
  };
  setStoredTokens(tokens);
  sessionStorage.removeItem("vtm:pkce");
  return tokens;
}

export function signOut(): void {
  clearTokens();
  // Drop the anonymous-id so a logged-out user starts fresh next session
  // rather than inheriting whatever anon tasks happened to exist.
  try {
    import("./anon-id").then((m) => m.clearAnonId()).catch(() => {});
  } catch {
    /* ignore */
  }
  if (!isCognitoConfigured()) {
    window.location.href = "/";
    return;
  }
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    logout_uri: window.location.origin
  });
  window.location.href = `https://${DOMAIN}/logout?${params}`;
}

// ---------- PKCE ----------

async function generatePkcePair(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  const codeVerifier = base64UrlEncode(bytes);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier)
  );
  const codeChallenge = base64UrlEncode(new Uint8Array(hash));
  return { codeVerifier, codeChallenge };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------- JWT claims (for displaying user info) ----------

export interface IdTokenClaims {
  sub: string;
  email?: string;
  name?: string;
  given_name?: string;
}

export function decodeIdToken(token: string): IdTokenClaims | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return null;
  }
}
