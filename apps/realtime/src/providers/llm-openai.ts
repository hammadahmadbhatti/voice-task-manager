import OpenAI from "openai";
import { OPENAI_TOOL_SPECS } from "@vtm/shared";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Thin OpenAI client + a streaming wrapper.
 *
 * We use chat.completions (not the new Responses API) because tool-call
 * streaming + parallel tool calls are battle-tested there. GPT-4o-mini is
 * the model — strong tool use, ~$0.15/$0.60 per 1M tokens, ~400 ms TTFT.
 */

export const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });

export const LLM_MODEL = "gpt-4o-mini";

/**
 * Tool call accumulator. OpenAI streams partial tool-call JSON in chunks,
 * keyed by index. We assemble them per-chunk and surface the completed
 * call when the stream finishes (finish_reason === "tool_calls").
 */
export interface AssembledToolCall {
  id: string;
  name: string;
  argsRaw: string; // raw JSON string — caller parses + zod-validates
}

export interface StreamCallbacks {
  /** Token deltas of the natural-language reply. */
  onTextDelta: (delta: string) => void;
  /** Fired once when the LLM's text turn ends without a tool call. */
  onTextDone: (full: string) => void;
  /** Fired when finish_reason is tool_calls. */
  onToolCalls: (calls: AssembledToolCall[]) => void;
  onError: (err: unknown) => void;
}

export interface StreamOptions {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  /** AbortController.signal — let callers cancel mid-stream on interruption. */
  signal: AbortSignal;
  /** Per-call temperature, defaults to 0.3 (tight, deterministic-ish). */
  temperature?: number;
  /** Hard deadline in ms. Returns onError on timeout. */
  timeoutMs?: number;
}

export async function streamCompletion(
  opts: StreamOptions,
  cb: StreamCallbacks
): Promise<void> {
  const { messages, signal, temperature = 0.3, timeoutMs = 12_000 } = opts;

  const timeoutHandle = setTimeout(() => {
    logger.warn("LLM timeout reached, aborting");
    // Caller's controller may already be aborted; this guards the standalone case.
  }, timeoutMs);

  let textBuffer = "";
  // index → partial tool call (id, name, accumulated args JSON string)
  const toolCallParts = new Map<
    number,
    { id: string; name: string; argsRaw: string }
  >();

  try {
    const stream = await openai.chat.completions.create(
      {
        model: LLM_MODEL,
        messages,
        tools: OPENAI_TOOL_SPECS,
        tool_choice: "auto",
        parallel_tool_calls: true,
        temperature,
        stream: true
      },
      { signal }
    );

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (delta.content) {
        textBuffer += delta.content;
        cb.onTextDelta(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          const existing = toolCallParts.get(idx) ?? {
            id: "",
            name: "",
            argsRaw: ""
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.argsRaw += tc.function.arguments;
          toolCallParts.set(idx, existing);
        }
      }

      if (choice.finish_reason === "tool_calls") {
        const calls: AssembledToolCall[] = Array.from(toolCallParts.values());
        cb.onToolCalls(calls);
        return;
      }
      if (choice.finish_reason === "stop") {
        cb.onTextDone(textBuffer);
        return;
      }
    }

    // Stream ended without an explicit finish_reason — treat as done.
    cb.onTextDone(textBuffer);
  } catch (err: unknown) {
    const e = err as { name?: string };
    if (e?.name === "AbortError" || (err instanceof Error && err.name === "AbortError")) {
      logger.debug("LLM stream aborted (interruption)");
      return;
    }
    cb.onError(err);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
