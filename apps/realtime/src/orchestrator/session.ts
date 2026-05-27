import type {
  ConversationTurn,
  Locale,
  PendingConfirmation,
  ReferencedTask,
  SessionState
} from "@vtm/shared";

/**
 * In-memory per-connection session. Lives only as long as the WS
 * connection — long-term history goes to DynamoDB separately.
 *
 * Why in-memory and not Redis: the connection is sticky to one Node
 * process anyway, and the data doesn't survive a disconnect either way.
 * Moving to Redis is a 30-line change if/when we go multi-instance.
 */

const MAX_HISTORY = 30; // keep ~15 turns of dialogue
const MAX_REFERENCED = 8;
const PENDING_TTL_MS = 30_000;

export class Session {
  state: SessionState = "IDLE";

  /** Sliding-window conversation history for LLM context. */
  history: ConversationTurn[] = [];

  /** Tasks we've recently surfaced or acted on; resolves "the previous one" etc. */
  referenced: ReferencedTask[] = [];
  private mentionCounter = 0;

  /** Pending destructive action awaiting yes/no confirmation. */
  pending: PendingConfirmation | null = null;

  /** AbortController for any in-flight LLM/TTS that interruption should kill. */
  currentAbort: AbortController | null = null;

  constructor(
    public readonly sessionId: string,
    public readonly userId: string,
    public readonly locale: Locale,
    public readonly timezone: string,
    public readonly userName?: string
  ) {}

  pushTurn(turn: ConversationTurn): void {
    this.history.push(turn);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
  }

  /**
   * Record that the assistant mentioned this task (e.g. via a tool result
   * or in a spoken sentence). The most recent N references survive.
   */
  noteReference(taskId: string, mentionedAs: string): void {
    const filtered = this.referenced.filter((r) => r.taskId !== taskId);
    filtered.unshift({
      taskId,
      lastMentioned: ++this.mentionCounter,
      mentionedAs
    });
    this.referenced = filtered.slice(0, MAX_REFERENCED);
  }

  /** Replace the referenced list with a freshly-spoken ordered list. */
  replaceReferenceList(items: { taskId: string; mentionedAs: string }[]): void {
    this.referenced = items.slice(0, MAX_REFERENCED).map((it) => ({
      taskId: it.taskId,
      lastMentioned: ++this.mentionCounter,
      mentionedAs: it.mentionedAs
    }));
  }

  setPending(p: Omit<PendingConfirmation, "expiresAt">): void {
    this.pending = { ...p, expiresAt: Date.now() + PENDING_TTL_MS };
  }

  expireStalePending(): void {
    if (this.pending && this.pending.expiresAt < Date.now()) {
      this.pending = null;
    }
  }

  abortInflight(): void {
    this.currentAbort?.abort();
    this.currentAbort = null;
  }
}
