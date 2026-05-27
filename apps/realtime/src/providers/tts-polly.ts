import {
  PollyClient,
  SynthesizeSpeechCommand,
  type VoiceId
} from "@aws-sdk/client-polly";
import type { Locale } from "@vtm/shared";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Amazon Polly TTS — fallback when ElevenLabs is unavailable.
 *
 * Polly's neural voices have a 1M-character free tier for the first 12
 * months. Quality is "very good" — natural enough that users won't
 * notice the fallback for short utterances.
 *
 * Polly doesn't expose a true streaming API for synthesis (the response
 * is a single audio blob). We chunk it ourselves to keep the WS flow
 * identical between providers.
 */

const polly = new PollyClient({ region: config.AWS_REGION });

const VOICE_FOR: Record<Locale, VoiceId> = {
  // Neural voices supported in eu-central-1
  en: "Joanna",
  de: "Vicki"
};

export interface PollyStreamOptions {
  text: string;
  locale: Locale;
  signal: AbortSignal;
}

export async function* streamPollyTts(
  opts: PollyStreamOptions
): AsyncGenerator<Uint8Array, void, unknown> {
  const cmd = new SynthesizeSpeechCommand({
    Text: opts.text,
    OutputFormat: "mp3",
    SampleRate: "22050",
    VoiceId: VOICE_FOR[opts.locale],
    Engine: "neural",
    LanguageCode: opts.locale === "de" ? "de-DE" : "en-US"
  });

  const res = await polly.send(cmd, { abortSignal: opts.signal });
  if (!res.AudioStream) {
    throw new Error("Polly returned no AudioStream");
  }

  // AudioStream is a Readable / web ReadableStream depending on platform.
  // Iterate generically.
  const stream = res.AudioStream as AsyncIterable<Uint8Array>;
  let bytes = 0;
  for await (const chunk of stream) {
    if (opts.signal.aborted) return;
    bytes += chunk.byteLength;
    yield chunk;
  }
  logger.debug({ bytes, voice: VOICE_FOR[opts.locale] }, "Polly synthesis complete");
}
