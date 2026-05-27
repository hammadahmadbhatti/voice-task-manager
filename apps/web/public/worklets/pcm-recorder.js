/**
 * AudioWorklet processor: downsamples mono Float32 from the AudioContext
 * sample rate (typically 48 kHz) to PCM 16-bit 16 kHz and posts frames
 * to the main thread.
 *
 * Why a worklet vs. ScriptProcessorNode: ScriptProcessor is deprecated
 * and runs on the main thread (glitches under load). Worklets run on
 * the audio thread, so capture stays smooth even when React is rerendering.
 */

class PcmRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { inputSampleRate = 48000, outputSampleRate = 16000 } =
      options.processorOptions ?? {};
    this.inputSampleRate = inputSampleRate;
    this.outputSampleRate = outputSampleRate;
    this.ratio = inputSampleRate / outputSampleRate;
    this.buffer = [];
    // ~20 ms of audio at 16 kHz = 320 samples = 640 bytes.
    this.frameSize = 640;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    // Downsample by linear interpolation (good enough for STT).
    const outLen = Math.floor(channel.length / this.ratio);
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * this.ratio;
      const i0 = Math.floor(srcIdx);
      const i1 = Math.min(i0 + 1, channel.length - 1);
      const frac = srcIdx - i0;
      const sample = channel[i0] * (1 - frac) + channel[i1] * frac;
      // Float32 -1..1 → Int16 -32768..32767
      const clamped = Math.max(-1, Math.min(1, sample));
      out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }

    // Concatenate into a rolling buffer; emit fixed-size frames.
    this.buffer.push(out);
    let total = 0;
    for (const a of this.buffer) total += a.length;

    while (total >= this.frameSize) {
      const frame = new Int16Array(this.frameSize);
      let written = 0;
      while (written < this.frameSize && this.buffer.length > 0) {
        const head = this.buffer[0];
        const need = this.frameSize - written;
        if (head.length <= need) {
          frame.set(head, written);
          written += head.length;
          this.buffer.shift();
        } else {
          frame.set(head.subarray(0, need), written);
          this.buffer[0] = head.subarray(need);
          written = this.frameSize;
        }
      }
      total -= this.frameSize;
      // Transfer underlying ArrayBuffer so we don't copy.
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-recorder", PcmRecorder);
