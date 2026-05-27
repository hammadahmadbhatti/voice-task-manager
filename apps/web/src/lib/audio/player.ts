/**
 * Streaming TTS playback queue.
 *
 * We receive MP3 chunks over the WS. We buffer them into a single
 * MediaSource (MSE) so playback can begin as soon as the first chunk
 * arrives, even before the full audio is downloaded.
 *
 * On interruption (.stop()), we tear down the MediaSource and revoke
 * the object URL synchronously — playback halts in <50 ms.
 *
 * Browser fallback: if MSE isn't available (mainly Safari iOS), we
 * fall back to SpeechSynthesis when the server signals provider=browser.
 */

export class StreamPlayer {
  private audio: HTMLAudioElement | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  private appending = false;
  private ended = false;
  private url: string | null = null;
  /** Bumps on every .stop() — discards chunks queued before a barge-in. */
  private generation = 0;

  /** Begin a fresh playback session. Must be called BEFORE feeding chunks. */
  start(): { generation: number } {
    this.stop();
    this.generation++;
    const gen = this.generation;

    if (typeof MediaSource === "undefined") {
      // No MSE — caller should fall back to SpeechSynthesis.
      return { generation: gen };
    }

    this.mediaSource = new MediaSource();
    this.url = URL.createObjectURL(this.mediaSource);
    this.audio = new Audio(this.url);
    this.audio.autoplay = true;

    this.mediaSource.addEventListener("sourceopen", () => {
      if (!this.mediaSource) return;
      try {
        this.sourceBuffer = this.mediaSource.addSourceBuffer("audio/mpeg");
        this.sourceBuffer.mode = "sequence";
        this.sourceBuffer.addEventListener("updateend", () => {
          this.pump();
        });
        this.pump();
      } catch (err) {
        console.error("MSE setup failed", err);
      }
    });

    this.audio.play().catch((err) => {
      // Autoplay may be blocked until the user has interacted; for our use
      // case the user *just* tapped the mic button, so we should be fine.
      console.warn("Audio play blocked:", err);
    });

    return { generation: gen };
  }

  /** Append a chunk to the current playback session. */
  push(generation: number, chunk: Uint8Array): void {
    if (generation !== this.generation) return; // stale chunk from interrupted session
    this.queue.push(chunk);
    this.pump();
  }

  /** Signal that no more chunks will be appended. */
  end(generation: number): void {
    if (generation !== this.generation) return;
    this.ended = true;
    this.pump();
  }

  /** Hard stop — used for barge-in. */
  stop(): void {
    this.queue.length = 0;
    this.appending = false;
    this.ended = false;
    try {
      if (this.audio) {
        this.audio.pause();
        this.audio.src = "";
        this.audio.load();
      }
    } catch {
      /* swallow */
    }
    try {
      if (
        this.mediaSource &&
        this.mediaSource.readyState === "open"
      ) {
        this.mediaSource.endOfStream();
      }
    } catch {
      /* swallow */
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    this.audio = null;
    this.mediaSource = null;
    this.sourceBuffer = null;
  }

  private pump(): void {
    if (this.appending) return;
    if (!this.sourceBuffer) return;
    if (this.sourceBuffer.updating) return;

    const chunk = this.queue.shift();
    if (!chunk) {
      if (this.ended && this.mediaSource?.readyState === "open") {
        try {
          this.mediaSource.endOfStream();
        } catch {
          /* swallow */
        }
      }
      return;
    }
    this.appending = true;
    try {
      // `appendBuffer` wants `BufferSource`. TS 5.5+ no longer narrows
      // `Uint8Array<ArrayBufferLike>` to it without an explicit cast,
      // so we hand it the underlying ArrayBuffer slice.
      const view = chunk.buffer.slice(
        chunk.byteOffset,
        chunk.byteOffset + chunk.byteLength
      ) as ArrayBuffer;
      this.sourceBuffer.appendBuffer(view);
    } catch (err) {
      console.error("appendBuffer failed", err);
    } finally {
      this.appending = false;
    }
  }
}

/**
 * Last-resort fallback using the browser's built-in SpeechSynthesis.
 * Used when the server signals provider=browser (all server TTS failed)
 * or when MSE is unavailable.
 */
export function speakWithBrowserSynthesis(text: string, lang: "en" | "de"): {
  cancel: () => void;
} {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    return { cancel: () => {} };
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === "de" ? "de-DE" : "en-US";
  u.rate = 1.05;
  u.pitch = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  return {
    cancel: () => window.speechSynthesis.cancel()
  };
}
