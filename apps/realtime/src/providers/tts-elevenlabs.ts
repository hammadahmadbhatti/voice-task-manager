import type { Locale } from "@vtm/shared";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Streaming TTS via ElevenLabs Flash v2.5 model (~75 ms TTFB).
 *
 * Uses the HTTP streaming endpoint rather than the WebSocket "input
 * streaming" API — for our use case (full sentence in hand before TTS
 * starts) HTTP streaming is simpler, equally fast TTFB, and lets us
 * surface chunks directly to the client over our own WS.
 *
 * Returns an async iterator of MP3 chunks. The caller forwards them
 * over the client WebSocket. Aborting the AbortSignal cancels the
 * fetch and frees the connection.
 */

export interface ElevenLabsStreamOptions {
  text: string;
  locale: Locale;
  signal: AbortSignal;
}

const VOICE_FOR: Record<Locale, () => string> = {
  en: () => config.ELEVENLABS_VOICE_ID_EN,
  de: () => config.ELEVENLABS_VOICE_ID_DE
};

export async function* streamElevenLabsTts(
  opts: ElevenLabsStreamOptions
): AsyncGenerator<Uint8Array, void, unknown> {
  const voiceId = VOICE_FOR[opts.locale]();
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=mp3_22050_32`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": config.ELEVENLABS_API_KEY,
      "content-type": "application/json",
      accept: "audio/mpeg"
    },
    body: JSON.stringify({
      text: opts.text,
      model_id: "eleven_flash_v2_5",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true
      }
    }),
    signal: opts.signal
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    logger.error(
      { status: res.status, detail },
      "ElevenLabs TTS request failed"
    );
    throw new Error(`ElevenLabs ${res.status}: ${detail}`);
  }

  const reader = res.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) {
        yield value;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* swallow */
    }
  }
}
