"use client";

/**
 * Stable client-generated anonymous ID.
 *
 * Persisted in localStorage so the same browser tab + profile keeps the
 * same anonymous identity across page reloads. Used as the fallback
 * `external_id` on the server (`anon:<uuid>`) when the user isn't
 * signed in.
 *
 * Both the WebSocket `hello` and REST requests carry this — that's
 * what guarantees the task list the UI fetches via REST matches the
 * tasks created via voice over the WebSocket.
 */

const STORAGE_KEY = "vtm:anon-id";

export function getOrCreateAnonId(): string {
  if (typeof window === "undefined") return "ssr-placeholder";
  let id = window.localStorage.getItem(STORAGE_KEY);
  if (id && isUuid(id)) return id;
  id = generateUuidV4();
  window.localStorage.setItem(STORAGE_KEY, id);
  return id;
}

export function clearAnonId(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function generateUuidV4(): string {
  // Type-safe global access — TS doesn't narrow globalThis.crypto across branches.
  const g = globalThis as unknown as { crypto?: Crypto };
  // Prefer the modern API when available.
  if (g.crypto && typeof g.crypto.randomUUID === "function") {
    return g.crypto.randomUUID();
  }
  // Manual v4 fallback (older Safari)
  if (!g.crypto?.getRandomValues) {
    // Last-resort non-crypto fallback. Never happens in real browsers but
    // keeps TS happy and the function total.
    return "00000000-0000-4000-8000-" + Date.now().toString(16).padStart(12, "0");
  }
  const bytes = new Uint8Array(16);
  g.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
