import type { Locale } from "@vtm/shared";
import { streamElevenLabsTts } from "./tts-elevenlabs.js";
import { streamPollyTts } from "./tts-polly.js";
import { logger } from "../utils/logger.js";

/**
 * Provider fallback chain: ElevenLabs → Polly → (client falls back to
 * browser SpeechSynthesis if both fail; signaled via `provider: "browser"`).
 *
 * The chain attempts each provider for *at most one chunk* before
 * committing — once we've streamed audio bytes to the client we cannot
 * realistically retry, so we only fail over on the first chunk.
 */

export type TtsProvider = "elevenlabs" | "polly" | "browser";

export interface TtsChainResult {
  provider: TtsProvider;
  /** "mp3" for our supported providers; if "browser" we send no audio */
  format: "mp3";
  stream: AsyncGenerator<Uint8Array, void, unknown>;
}

export async function openTtsStream(
  text: string,
  locale: Locale,
  signal: AbortSignal
): Promise<TtsChainResult> {
  // 1) ElevenLabs
  try {
    const stream = await primedStream(streamElevenLabsTts({ text, locale, signal }));
    return { provider: "elevenlabs", format: "mp3", stream };
  } catch (err) {
    logger.warn({ err }, "ElevenLabs failed, falling back to Polly");
  }

  // 2) Polly
  try {
    const stream = await primedStream(streamPollyTts({ text, locale, signal }));
    return { provider: "polly", format: "mp3", stream };
  } catch (err) {
    logger.error({ err }, "Polly also failed; client should use SpeechSynthesis");
  }

  // 3) Browser fallback signal
  async function* empty(): AsyncGenerator<Uint8Array, void, unknown> {
    /* no chunks */
  }
  return { provider: "browser", format: "mp3", stream: empty() };
}

/**
 * Wraps an async generator so we await the first chunk before returning —
 * this lets us catch upstream failures (e.g. 401, 429) at the *open* phase,
 * before we've committed any state to the client.
 */
async function primedStream(
  gen: AsyncGenerator<Uint8Array, void, unknown>
): Promise<AsyncGenerator<Uint8Array, void, unknown>> {
  const first = await gen.next();
  if (first.done) {
    // Generator yielded nothing — treat as failure to "prime" the stream.
    throw new Error("TTS provider returned empty stream");
  }
  // Re-emit the first chunk, then continue with the rest.
  // first.value is non-null here because we just checked first.done === false.
  const head: Uint8Array = first.value as Uint8Array;
  async function* replay(): AsyncGenerator<Uint8Array, void, unknown> {
    yield head;
    while (true) {
      const next = await gen.next();
      if (next.done) return;
      yield next.value;
    }
  }
  return replay();
}
