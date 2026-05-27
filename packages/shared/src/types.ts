/**
 * Core domain types shared between web and realtime backend.
 * Keep this file dependency-free — it ships to both Node and the browser.
 */

export type Locale = "en" | "de";

export type TaskStatus = "pending" | "done" | "cancelled";

/**
 * A scheduled task. `scheduledAt` is always stored in UTC (ISO 8601).
 * Time zone is the user's local zone, captured at creation time so we
 * can present consistently across devices.
 */
export interface Task {
  id: string;
  userId: string;
  title: string;
  description?: string;
  /** ISO 8601 UTC, e.g. "2026-05-26T17:00:00.000Z" */
  scheduledAt: string;
  /** IANA timezone the user was in when they created the task */
  timezone: string;
  durationMinutes: number;
  status: TaskStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ConversationTurn {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  /** Set when role === "tool" — the tool that produced this content */
  toolName?: string;
  /**
   * Set when role === "tool" — the originating tool_call's ID.
   * Required for OpenAI: every tool_calls entry on an assistant message
   * MUST have a matching tool message with the same tool_call_id, or the
   * API returns 400. Per-call IDs matter especially for parallel calls
   * where multiple results share the same `toolName`.
   */
  toolCallId?: string;
  /** Tool calls emitted by the assistant on this turn */
  toolCalls?: ToolCall[];
  timestamp: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * State machine states for the conversation orchestrator.
 *
 * IDLE              → waiting for user speech
 * LISTENING         → STT actively transcribing
 * THINKING          → LLM generating a response / tool call
 * EXECUTING_TOOL    → a CRUD tool is running
 * SPEAKING          → TTS audio is streaming to client
 * AWAITING_CONFIRM  → destructive action queued, waiting for explicit yes/no
 */
export type SessionState =
  | "IDLE"
  | "LISTENING"
  | "THINKING"
  | "EXECUTING_TOOL"
  | "SPEAKING"
  | "AWAITING_CONFIRM";

/**
 * A pending destructive action that the user has not yet confirmed.
 * Held in session memory with a 30-second TTL.
 */
export interface PendingConfirmation {
  action: "delete" | "bulk_delete";
  taskIds: string[];
  summary: string;
  expiresAt: number; // epoch ms
}

/**
 * Salience-tracked task reference in working memory. Used to resolve
 * vague references like "the previous one", "the second one", "it".
 */
export interface ReferencedTask {
  taskId: string;
  /** monotonic counter — most recent mention wins ties */
  lastMentioned: number;
  /** how the task was referred to, helps disambiguation */
  mentionedAs: string;
}
