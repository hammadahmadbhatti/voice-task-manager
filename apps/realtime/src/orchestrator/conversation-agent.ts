import type OpenAI from "openai";
import { buildSystemPrompt } from "@vtm/shared";
import type { ServerMessage } from "@vtm/shared";
import { logger } from "../utils/logger.js";
import { streamCompletion } from "../providers/llm-openai.js";
import { openTtsStream } from "../providers/tts-chain.js";
import { executeTool } from "../agents/task-tools.js";
import type { Session } from "./session.js";

/**
 * The conversation agent: an iteration loop that drives one user
 * utterance to a spoken response.
 *
 *   1. Build system prompt with fresh CURRENT_DATETIME + working memory
 *   2. Call LLM (streaming)
 *   3a. If the LLM emits text → stream TTS in parallel; finish
 *   3b. If the LLM emits tool calls →
 *        - run them
 *        - if any handler asked us to speak directly (e.g. confirmation
 *          prompt), do that and stop
 *        - otherwise feed tool results back and loop (max 4 iterations
 *          to bound cost; this handles "find_tasks then update_task"
 *          patterns cleanly)
 *
 * The `send` callback is how we surface progress to the WS client.
 *
 * `abortSignal` is the session-level controller. Anything mid-flight
 * (LLM stream, TTS stream) must respect it so barge-in feels instant.
 */

export interface RunTurnArgs {
  session: Session;
  userText: string;
  send: (msg: ServerMessage) => void;
  /** Raw binary frames go through this separate channel. */
  sendAudio: (chunk: Uint8Array) => void;
  abortSignal: AbortSignal;
}

const MAX_TOOL_ITERATIONS = 4;

export async function runTurn(args: RunTurnArgs): Promise<void> {
  const { session, userText, send, sendAudio, abortSignal } = args;

  // Record the user turn before we do anything else.
  session.pushTurn({
    role: "user",
    content: userText,
    timestamp: new Date().toISOString()
  });
  session.expireStalePending();

  send({ type: "state", state: "THINKING" });

  // Iterate up to MAX_TOOL_ITERATIONS times: each iteration is one
  // LLM call. We exit either with spoken text (success) or by running
  // out of iterations (degraded path; speak an apology).
  let toolIteration = 0;
  let finalText: string | null = null;
  let speakDirectly: string | null = null;

  while (toolIteration < MAX_TOOL_ITERATIONS) {
    toolIteration++;
    const messages = buildMessages(session);

    let textBuffer = "";
    const toolCallsCollected: Array<{
      id: string;
      name: string;
      argsRaw: string;
    }> = [];
    let llmError: unknown = null;

    await streamCompletion(
      {
        messages,
        signal: abortSignal,
        timeoutMs: 12_000
      },
      {
        onTextDelta: (delta) => {
          textBuffer += delta;
          send({ type: "assistant_text", delta, done: false });
        },
        onTextDone: (full) => {
          textBuffer = full;
        },
        onToolCalls: (calls) => {
          toolCallsCollected.push(...calls);
        },
        onError: (err) => {
          llmError = err;
        }
      }
    );

    if (abortSignal.aborted) {
      logger.debug("Turn aborted before completion");
      return;
    }

    if (llmError) {
      logger.error({ err: llmError }, "LLM error during turn");
      send({
        type: "error",
        code: "llm_failed",
        message:
          "I'm having trouble thinking right now — could you try again?",
        retryable: true
      });
      return;
    }

    if (toolCallsCollected.length === 0) {
      // Pure text reply — we're done.
      send({ type: "assistant_text", delta: "", done: true });
      session.pushTurn({
        role: "assistant",
        content: textBuffer,
        timestamp: new Date().toISOString()
      });
      finalText = textBuffer.trim();
      break;
    }

    // Execute tools serially. Each handler may decide to halt the loop
    // (e.g. delete confirmation) or update working memory.
    session.pushTurn({
      role: "assistant",
      content: textBuffer,
      toolCalls: toolCallsCollected.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: safeParseArgs(c.argsRaw)
      })),
      timestamp: new Date().toISOString()
    });

    let halted = false;
    for (const call of toolCallsCollected) {
      send({
        type: "state",
        state: "EXECUTING_TOOL",
        hint: `tool:${call.name}`
      });
      const result = await executeTool(call.name, call.argsRaw, { session });

      // Surface task list mutations to the client immediately.
      if (result.taskEvent) {
        send({
          type: "task_event",
          action: result.taskEvent.action,
          taskId: result.taskEvent.taskId,
          task: result.taskEvent.task
        });
      }

      session.pushTurn({
        role: "tool",
        toolName: call.name,
        // CRITICAL for OpenAI: parallel tool calls share the same name but
        // need distinct tool_call_ids on their response messages.
        toolCallId: call.id,
        content: JSON.stringify({
          ok: result.ok,
          data: result.data,
          error: result.error
        }),
        timestamp: new Date().toISOString()
      });

      // We push results back to the LLM as ChatCompletion `tool` messages
      // in the next iteration via buildMessages().

      if (result.speakDirectly) {
        speakDirectly = result.speakDirectly;
      }
      if (result.haltAfter) {
        halted = true;
        break;
      }
    }

    if (halted) {
      // A handler took over the spoken response (confirmation prompt,
      // clarification, etc.). Speak it and exit the loop.
      break;
    }

    // Otherwise: round-trip back to the LLM with tool results in history.
    send({ type: "state", state: "THINKING" });
  }

  // ---------- Speak the response ----------

  const textToSpeak =
    speakDirectly ??
    finalText ??
    (session.locale === "de"
      ? "Entschuldige, da ist etwas schiefgelaufen."
      : "Sorry, something went wrong on my end.");

  // If the tool produced a direct-speak response that wasn't streamed
  // to the client as deltas, send it as one block so the UI transcript
  // stays in sync.
  if (speakDirectly) {
    send({ type: "assistant_text", delta: speakDirectly, done: true });
    session.pushTurn({
      role: "assistant",
      content: speakDirectly,
      timestamp: new Date().toISOString()
    });
  }

  await speak(session, textToSpeak, send, sendAudio, abortSignal);
}

// ---------- Helpers ----------

/**
 * Exported for unit tests. Builds the OpenAI chat-completions message array
 * from a Session's conversation history, enforcing the invariant that every
 * assistant `tool_calls` entry has a matching tool response.
 */
export function buildMessages(
  session: Session
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const system = buildSystemPrompt({
    locale: session.locale,
    currentDateTime: formatCurrentDateTime(session.timezone),
    timezone: session.timezone,
    userName: session.userName,
    recentlyReferenced: session.referenced,
    pendingConfirmation: session.pending
  });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system }
  ];

  // Two invariants the OpenAI Chat Completions API enforces:
  //
  //   A. Every assistant.tool_calls[i] must have a matching tool message
  //      *after* the assistant turn and *before* the next user/assistant
  //      turn. Otherwise: 400 "tool_call_ids did not have response messages".
  //
  //   B. Every tool message must be preceded by an assistant turn that
  //      declared its tool_call_id. Otherwise: 400 "messages with role
  //      'tool' must be a response to a preceeding message with 'tool_calls'".
  //
  // History trimming (MAX_HISTORY=30) can split either invariant:
  //   - splice off a tool turn → invariant A broken
  //   - splice off the declaring assistant → invariant B broken
  //
  // We enforce both with a two-pass scan. First pass: identify which
  // assistant+tools "groups" survived intact and collect the valid
  // tool_call_ids. Second pass: emit messages, dropping anything that
  // would violate either invariant.

  const turns = session.history;
  const skipIndex = new Set<number>();
  const validToolCallIds = new Set<string>();

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (!turn || turn.role !== "assistant" || !turn.toolCalls?.length) continue;

    const expectedIds = new Set(turn.toolCalls.map((tc) => tc.id));
    const respondedIds = new Set<string>();
    let scan = i + 1;
    while (scan < turns.length) {
      const next = turns[scan];
      if (!next) break;
      if (next.role === "tool" && next.toolCallId) {
        respondedIds.add(next.toolCallId);
        scan++;
        continue;
      }
      // next assistant or user turn → end of this tool batch
      if (next.role === "assistant" || next.role === "user") break;
      scan++;
    }
    const orphaned = [...expectedIds].some((id) => !respondedIds.has(id));
    if (orphaned) {
      // Invariant A: drop the whole assistant + partial tool batch.
      skipIndex.add(i);
      for (let k = i + 1; k < scan; k++) skipIndex.add(k);
    } else {
      // This assistant's tool_call_ids are valid declarations — tool
      // turns referencing them in pass 2 are safe to emit.
      for (const id of expectedIds) validToolCallIds.add(id);
    }
  }

  for (let i = 0; i < turns.length; i++) {
    if (skipIndex.has(i)) continue;
    const turn = turns[i];
    if (!turn) continue;

    switch (turn.role) {
      case "user":
        messages.push({ role: "user", content: turn.content });
        break;
      case "assistant": {
        if (turn.toolCalls && turn.toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: turn.content || null,
            tool_calls: turn.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments)
              }
            }))
          });
        } else {
          messages.push({ role: "assistant", content: turn.content });
        }
        break;
      }
      case "tool": {
        // Invariant B: only emit tool messages whose tool_call_id was
        // declared by a surviving (non-skipped) assistant turn. This
        // catches the case where history-trim sliced off the assistant
        // but kept the tool messages.
        if (turn.toolCallId && validToolCallIds.has(turn.toolCallId)) {
          messages.push({
            role: "tool",
            tool_call_id: turn.toolCallId,
            content: turn.content
          });
        }
        break;
      }
      case "system":
        // We always rebuild the system message — skip historical ones.
        break;
    }
  }

  return messages;
}

function formatCurrentDateTime(timezone: string): string {
  // ISO 8601 in the user's local zone
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) =>
    parts.find((p) => p.type === t)?.value ?? "00";
  const isoLocal = `${get("year")}-${get("month")}-${get("day")}T${get(
    "hour"
  )}:${get("minute")}:${get("second")}`;

  // Compute offset
  const offsetMinutes = -now.getTimezoneOffset(); // best-effort fallback
  const tzOffset = formatOffset(timezone, now) || formatOffsetFromMinutes(offsetMinutes);
  return `${isoLocal}${tzOffset}`;
}

function formatOffset(timezone: string, date: Date): string | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset"
    });
    const parts = fmt.formatToParts(date);
    const off = parts.find((p) => p.type === "timeZoneName")?.value;
    if (!off) return null;
    // e.g. "GMT+2" → "+02:00"
    const m = off.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return null;
    const sign = m[1];
    const hh = m[2]!.padStart(2, "0");
    const mm = (m[3] ?? "00").padStart(2, "0");
    return `${sign}${hh}:${mm}`;
  } catch {
    return null;
  }
}

function formatOffsetFromMinutes(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

async function speak(
  session: Session,
  text: string,
  send: (m: ServerMessage) => void,
  sendAudio: (b: Uint8Array) => void,
  signal: AbortSignal
): Promise<void> {
  if (!text || !text.trim()) {
    send({ type: "state", state: "IDLE" });
    return;
  }
  send({ type: "state", state: "SPEAKING" });

  const result = await openTtsStream(text, session.locale, signal);

  // Tell client what format to expect
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
    logger.warn({ err }, "TTS stream errored mid-flight");
  }

  send({ type: "tts_end", bytes });
  send({ type: "state", state: "IDLE" });
}
