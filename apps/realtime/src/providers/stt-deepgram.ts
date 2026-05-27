import { createClient, LiveTranscriptionEvents, type LiveClient } from "@deepgram/sdk";
import type { Locale } from "@vtm/shared";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Thin wrapper around Deepgram's streaming STT.
 *
 * Lifecycle:
 *   const stt = new DeepgramStream(locale, callbacks);
 *   await stt.open();
 *   stt.send(pcmFrame);   // many times
 *   stt.flushAndClose();  // VAD endpoint
 *
 * Callbacks:
 *   onPartial(text, confidence) — interim transcript, may be revised
 *   onFinal(text, confidence)   — finalized utterance
 *   onError(err)                — non-recoverable
 *   onClose()                   — cleanup
 */

export interface DeepgramCallbacks {
  onPartial: (text: string, confidence: number) => void;
  onFinal: (text: string, confidence: number) => void;
  onError: (err: unknown) => void;
  onClose: () => void;
}

const LOCALE_TO_DG_LANG: Record<Locale, string> = {
  en: "en-US",
  de: "de"
};

export class DeepgramStream {
  private client = createClient(config.DEEPGRAM_API_KEY);
  private live: LiveClient | null = null;
  private closed = false;
  private keepAliveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly locale: Locale,
    private readonly cb: DeepgramCallbacks
  ) {}

  open(): void {
    this.live = this.client.listen.live({
      model: "nova-2-general",
      language: LOCALE_TO_DG_LANG[this.locale],
      encoding: "linear16",
      sample_rate: 16000,
      channels: 1,
      interim_results: true,
      smart_format: true,
      // Endpointing handled client-side via VAD, but Deepgram's own
      // utterance_end_ms gives us a safety net.
      utterance_end_ms: 1200,
      vad_events: true,
      punctuate: true
    });

    this.live.on(LiveTranscriptionEvents.Open, () => {
      logger.debug({ locale: this.locale }, "Deepgram socket open");
      // Some networks idle out — keep-alive every 8 s.
      this.keepAliveTimer = setInterval(() => {
        try {
          this.live?.keepAlive();
        } catch {
          /* swallow */
        }
      }, 8000);
    });

    this.live.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alt = data?.channel?.alternatives?.[0];
      if (!alt) return;
      const text: string = alt.transcript ?? "";
      const confidence: number = alt.confidence ?? 0;
      if (!text) return;

      if (data.is_final) {
        this.cb.onFinal(text, confidence);
      } else {
        this.cb.onPartial(text, confidence);
      }
    });

    this.live.on(LiveTranscriptionEvents.Error, (err) => {
      logger.error({ err }, "Deepgram error");
      this.cb.onError(err);
    });

    this.live.on(LiveTranscriptionEvents.Close, () => {
      logger.debug("Deepgram socket closed");
      this.cleanup();
      this.cb.onClose();
    });
  }

  send(pcmFrame: ArrayBuffer | Buffer): void {
    if (this.closed || !this.live) return;
    try {
      // Deepgram's `send()` accepts a Buffer or ArrayBuffer; the SDK's union
      // type doesn't narrow Buffer<ArrayBufferLike> cleanly in TS 5.5+, so
      // we route everything through an explicit ArrayBuffer view.
      const view =
        Buffer.isBuffer(pcmFrame)
          ? pcmFrame.buffer.slice(
              pcmFrame.byteOffset,
              pcmFrame.byteOffset + pcmFrame.byteLength
            )
          : pcmFrame;
      this.live.send(view);
    } catch (err) {
      logger.warn({ err }, "Deepgram send failed");
    }
  }

  flushAndClose(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.live?.finish();
    } catch (err) {
      logger.warn({ err }, "Deepgram finish failed");
    }
    this.cleanup();
  }

  private cleanup(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}
