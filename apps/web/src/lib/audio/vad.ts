"use client";

import type { MicVAD } from "@ricky0123/vad-web";

/**
 * Silero VAD wrapper. Tracks speech/silence transitions and emits callbacks.
 *
 * Why a separate VAD on top of Deepgram's own endpointing:
 *   1. Lets us detect barge-in DURING TTS playback (Deepgram only listens
 *      while we're sending it audio).
 *   2. Lets us trim leading silence before opening the Deepgram socket,
 *      which saves cost and improves first-word latency.
 *   3. Gives us a confidence value we can show in the UI.
 *
 * Silero is ~1.8 MB of ONNX + ~150 KB of WASM, loaded lazily on demand.
 */

export interface VADCallbacks {
  /** User started talking. Trigger barge-in if assistant is speaking. */
  onSpeechStart: () => void;
  /** Endpoint detected — user finished an utterance. */
  onSpeechEnd: () => void;
  /** Misfire (speech was too short). Optional. */
  onMisfire?: () => void;
}

export class VADController {
  private vad: MicVAD | null = null;
  private cb: VADCallbacks | null = null;
  private starting = false;

  async start(cb: VADCallbacks): Promise<void> {
    if (this.starting || this.vad) return;
    this.starting = true;
    this.cb = cb;

    const { MicVAD } = await import("@ricky0123/vad-web");

    this.vad = await MicVAD.new({
      // Silero v5 defaults are aggressive; soften them slightly for natural speech.
      positiveSpeechThreshold: 0.6,
      negativeSpeechThreshold: 0.4,
      minSpeechMs: 40,
      preSpeechPadMs: 40,
      redemptionMs: 120,
      onSpeechStart: () => this.cb?.onSpeechStart(),
      // onSpeechEnd receives the captured audio; we ignore it (Deepgram already
      // has the streamed copy) and just signal endpoint.
      onSpeechEnd: () => this.cb?.onSpeechEnd(),
      onVADMisfire: () => this.cb?.onMisfire?.()
    });
    this.starting = false;
    this.vad.start();
  }

  pause(): void {
    this.vad?.pause();
  }

  resume(): void {
    this.vad?.start();
  }

  async destroy(): Promise<void> {
    if (!this.vad) return;
    try {
      this.vad.pause();
      this.vad.destroy();
    } catch {
      /* swallow */
    }
    this.vad = null;
    this.cb = null;
  }
}
