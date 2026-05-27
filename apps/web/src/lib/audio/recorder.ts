/**
 * Microphone capture: getUserMedia → AudioWorklet → 16 kHz PCM Int16 frames.
 *
 * Usage:
 *   const rec = new MicRecorder();
 *   await rec.start((frame) => ws.send(frame));
 *   ...
 *   rec.stop();
 *
 * frame is an ArrayBuffer (Int16Array.buffer) of 640 bytes (20 ms).
 */

export type FrameHandler = (frame: ArrayBuffer) => void;

export class MicRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private started = false;

  async start(onFrame: FrameHandler): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // Some browsers default to 44.1 kHz, some 48 kHz. The worklet handles
    // any input rate.
    const ctx = new AudioContext({ latencyHint: "interactive" });
    await ctx.audioWorklet.addModule("/worklets/pcm-recorder.js");
    this.ctx = ctx;

    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, "pcm-recorder", {
      processorOptions: {
        inputSampleRate: ctx.sampleRate,
        outputSampleRate: 16000
      }
    });

    this.node.port.onmessage = (ev) => {
      onFrame(ev.data as ArrayBuffer);
    };

    this.source.connect(this.node);
    // We don't connect to ctx.destination — we don't want monitoring playback.
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    try {
      this.node?.disconnect();
    } catch {
      /* swallow */
    }
    try {
      this.source?.disconnect();
    } catch {
      /* swallow */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.node = null;
  }

  isRunning(): boolean {
    return this.started;
  }
}
