import type { ServerMessage } from "@vtm/shared";
import { openTtsStream } from "../providers/tts-chain.js";
import { logger } from "../utils/logger.js";
import type { Session } from "./session.js";

/**
 * Speak a fixed string without going through the LLM. Used for:
 *   - low-STT-confidence apologies
 *   - tool-staged confirmation prompts
 *   - error messages
 *
 * Same TTS streaming semantics as the agent's `speak()` — kept separate
 * so the LLM-driven path doesn't get tangled with it.
 */
export async function speakDirect(
  session: Session,
  text: string,
  send: (m: ServerMessage) => void,
  sendAudio: (b: Uint8Array) => void,
  signal: AbortSignal
): Promise<void> {
  if (!text.trim()) {
    send({ type: "state", state: "IDLE" });
    return;
  }
  send({ type: "state", state: "SPEAKING" });

  const result = await openTtsStream(text, session.locale, signal);
  send({
    type: "tts_start" as never,
    format: result.format,
    sampleRate: 22050
  } as unknown as ServerMessage);

  let bytes = 0;
  try {
    for await (const chunk of result.stream) {
      if (signal.aborted) break;
      bytes += chunk.byteLength;
      sendAudio(chunk);
    }
  } catch (err) {
    logger.warn({ err }, "speakDirect: TTS error");
  }
  send({ type: "tts_end", bytes });
  send({ type: "state", state: "IDLE" });
}
