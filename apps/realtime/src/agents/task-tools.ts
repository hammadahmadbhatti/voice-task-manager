import type { Task } from "@vtm/shared";
import {
  CreateTaskArgs,
  DeleteTaskArgs,
  FindTasksArgs,
  RequestClarificationArgs,
  UpdateTaskArgs
} from "@vtm/shared";
import {
  createTask,
  deleteTask,
  findTasks,
  getTaskById,
  updateTask
} from "../db/tasks-repo.js";
import type { Session } from "../orchestrator/session.js";
import { logger } from "../utils/logger.js";

/**
 * The runtime side of the LLM tools. Each handler:
 *   1. zod-validates the args (defense in depth — the model can still
 *      emit bad JSON despite the schema)
 *   2. Executes the side effect against DynamoDB
 *   3. Updates session memory (referenced tasks, pending confirmation)
 *   4. Returns a compact result object that goes back into the model
 *      as the tool's response message
 *
 * Tool results are intentionally terse — the model already has the
 * full conversation context, so we just need to surface the facts it
 * needs to compose a natural-language reply.
 */

export interface ToolContext {
  session: Session;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** When true, the orchestrator should NOT immediately re-call the LLM —
   *  e.g. a delete request that staged a confirmation prompt is finished. */
  haltAfter?: boolean;
  /** Optional spoken text the orchestrator should say verbatim,
   *  bypassing the LLM. Used for fast confirmation prompts. */
  speakDirectly?: string;
  /** Hint for the UI / client to update the task list optimistically. */
  taskEvent?: {
    action: "created" | "updated" | "deleted";
    taskId: string;
    task?: Task;
  };
}

// ---------- create_task ----------

export async function handleCreateTask(
  rawArgs: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const parsed = CreateTaskArgs.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid arguments: ${parsed.error.message}`
    };
  }
  const task = await createTask({
    userId: ctx.session.userId,
    title: parsed.data.title,
    description: parsed.data.description,
    scheduledAt: new Date(parsed.data.scheduledAt).toISOString(),
    timezone: ctx.session.timezone,
    durationMinutes: parsed.data.durationMinutes,
    tags: parsed.data.tags
  });
  ctx.session.noteReference(task.id, task.title);
  return {
    ok: true,
    data: {
      id: task.id,
      title: task.title,
      scheduledAt: task.scheduledAt,
      durationMinutes: task.durationMinutes
    },
    taskEvent: { action: "created", taskId: task.id, task }
  };
}

// ---------- find_tasks ----------

export async function handleFindTasks(
  rawArgs: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const parsed = FindTasksArgs.safeParse(rawArgs);
  if (!parsed.success) {
    return { ok: false, error: `Invalid arguments: ${parsed.error.message}` };
  }
  const args = parsed.data;

  let tasks = await findTasks({
    userId: ctx.session.userId,
    dateRangeStart: args.dateRangeStart
      ? new Date(args.dateRangeStart).toISOString()
      : undefined,
    dateRangeEnd: args.dateRangeEnd
      ? new Date(args.dateRangeEnd).toISOString()
      : undefined,
    status: args.status,
    limit: args.limit
  });

  // Time-of-day filter (computed in user TZ)
  if (args.timeOfDay !== "any") {
    tasks = tasks.filter((t) => {
      const hour = hourInTimezone(t.scheduledAt, ctx.session.timezone);
      return matchTimeOfDay(hour, args.timeOfDay);
    });
  }

  // Fuzzy text match on title
  if (args.query) {
    const q = args.query.toLowerCase();
    const scored = tasks
      .map((t) => ({ t, score: similarity(q, t.title.toLowerCase()) }))
      .filter((s) => s.score > 0.25)
      .sort((a, b) => b.score - a.score);
    tasks = scored.map((s) => s.t);
  }

  // Update working memory with this freshly-spoken list
  ctx.session.replaceReferenceList(
    tasks.map((t) => ({ taskId: t.id, mentionedAs: t.title }))
  );

  return {
    ok: true,
    data: {
      count: tasks.length,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        scheduledAt: t.scheduledAt,
        durationMinutes: t.durationMinutes,
        status: t.status
      }))
    }
  };
}

// ---------- update_task ----------

export async function handleUpdateTask(
  rawArgs: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const parsed = UpdateTaskArgs.safeParse(rawArgs);
  if (!parsed.success) {
    return { ok: false, error: `Invalid arguments: ${parsed.error.message}` };
  }
  const args = parsed.data;
  const existing = await getTaskById(ctx.session.userId, args.taskId);
  if (!existing) {
    return { ok: false, error: `No task found with id ${args.taskId}` };
  }

  const patch: Partial<Task> = {};
  if (args.title !== undefined) patch.title = args.title;
  if (args.scheduledAt !== undefined)
    patch.scheduledAt = new Date(args.scheduledAt).toISOString();
  if (args.durationMinutes !== undefined)
    patch.durationMinutes = args.durationMinutes;
  if (args.status !== undefined) patch.status = args.status;
  if (args.description !== undefined) patch.description = args.description;
  if (args.tags !== undefined) patch.tags = args.tags;

  const updated = await updateTask(ctx.session.userId, args.taskId, patch);
  if (!updated) {
    return { ok: false, error: "Update failed unexpectedly" };
  }
  ctx.session.noteReference(updated.id, updated.title);
  return {
    ok: true,
    data: {
      id: updated.id,
      title: updated.title,
      scheduledAt: updated.scheduledAt,
      status: updated.status
    },
    taskEvent: { action: "updated", taskId: updated.id, task: updated }
  };
}

// ---------- delete_task ----------

export async function handleDeleteTask(
  rawArgs: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const parsed = DeleteTaskArgs.safeParse(rawArgs);
  if (!parsed.success) {
    return { ok: false, error: `Invalid arguments: ${parsed.error.message}` };
  }
  const args = parsed.data;
  const existing = await getTaskById(ctx.session.userId, args.taskId);
  if (!existing) {
    return { ok: false, error: `No task found with id ${args.taskId}` };
  }

  // Defense in depth: even if the model sets confirmed=true incorrectly,
  // we still gate on the session's pending state.
  const sessionConfirmed =
    ctx.session.pending !== null &&
    ctx.session.pending.action === "delete" &&
    ctx.session.pending.taskIds.includes(args.taskId);

  if (!args.confirmed || !sessionConfirmed) {
    // Stage the confirmation; speak directly (don't burn an LLM call).
    ctx.session.setPending({
      action: "delete",
      taskIds: [args.taskId],
      summary: existing.title
    });
    const prompt = buildConfirmationPrompt(
      existing.title,
      ctx.session.locale
    );
    return {
      ok: true,
      haltAfter: true,
      speakDirectly: prompt,
      data: { staged: true, taskId: args.taskId }
    };
  }

  // Confirmed → execute
  const deleted = await deleteTask(ctx.session.userId, args.taskId);
  ctx.session.pending = null;
  if (!deleted) {
    return { ok: false, error: "Delete failed" };
  }
  return {
    ok: true,
    data: { id: args.taskId, title: existing.title },
    taskEvent: { action: "deleted", taskId: args.taskId }
  };
}

// ---------- request_clarification ----------

export async function handleRequestClarification(
  rawArgs: unknown,
  ctx: ToolContext
): Promise<ToolResult> {
  const parsed = RequestClarificationArgs.safeParse(rawArgs);
  if (!parsed.success) {
    return { ok: false, error: `Invalid arguments: ${parsed.error.message}` };
  }
  if (parsed.data.candidates) {
    ctx.session.replaceReferenceList(
      parsed.data.candidates.map((c) => ({
        taskId: c.taskId,
        mentionedAs: c.label
      }))
    );
  }
  // Speak the question directly — no need to round-trip the LLM.
  return {
    ok: true,
    haltAfter: true,
    speakDirectly: parsed.data.question
  };
}

// ---------- Dispatcher ----------

export const TOOL_HANDLERS = {
  create_task: handleCreateTask,
  find_tasks: handleFindTasks,
  update_task: handleUpdateTask,
  delete_task: handleDeleteTask,
  request_clarification: handleRequestClarification
} as const;

export async function executeTool(
  name: string,
  argsRaw: string,
  ctx: ToolContext
): Promise<ToolResult> {
  const handler = (TOOL_HANDLERS as Record<string, typeof handleCreateTask>)[
    name
  ];
  if (!handler) {
    return { ok: false, error: `Unknown tool: ${name}` };
  }

  let args: unknown;
  try {
    args = JSON.parse(argsRaw || "{}");
  } catch (err) {
    logger.warn({ err, argsRaw }, "Tool args were not valid JSON");
    return { ok: false, error: "Arguments were not valid JSON" };
  }

  try {
    return await handler(args, ctx);
  } catch (err) {
    logger.error({ err, name }, "Tool execution threw");
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

// ---------- Helpers ----------

function hourInTimezone(iso: string, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone: tz
  });
  return parseInt(fmt.format(new Date(iso)), 10);
}

function matchTimeOfDay(
  hour: number,
  bucket: "morning" | "afternoon" | "evening" | "night" | "any"
): boolean {
  switch (bucket) {
    case "morning":
      return hour >= 5 && hour < 12;
    case "afternoon":
      return hour >= 12 && hour < 17;
    case "evening":
      return hour >= 17 && hour < 21;
    case "night":
      return hour >= 21 || hour < 5;
    default:
      return true;
  }
}

/**
 * Tiny similarity score — bigram-based Sørensen–Dice. Good enough for
 * "linkedin post" → "Post on LinkedIn" semantic matching at this scale.
 * For richer matching, swap in an embedding lookup later.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) {
    const m = B.get(g) ?? 0;
    inter += Math.min(n, m);
  }
  const total = a.length - 1 + (b.length - 1);
  return total === 0 ? 0 : (2 * inter) / total;
}

function buildConfirmationPrompt(title: string, locale: "en" | "de"): string {
  if (locale === "de") {
    return `Möchtest du die Aufgabe „${title}" wirklich löschen? Bitte sag ja oder nein.`;
  }
  return `Are you sure you want to delete the "${title}" task? Please say yes or no.`;
}
