import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { Task, TaskStatus } from "@vtm/shared";
import { db } from "./client.js";
import { type DbTask, tasks } from "./schema.js";
import { logger } from "../utils/logger.js";

/**
 * Task CRUD against PostgreSQL. Repository pattern: callers pass our
 * internal `userId` (UUID from users.id), never the external identity
 * claim. All queries are scoped to user_id — even if a caller smuggles
 * in someone else's task ID, the WHERE clause will return nothing.
 */

export interface CreateTaskInput {
  userId: string;
  title: string;
  description?: string;
  /** ISO 8601 with offset; we parse to Date */
  scheduledAt: string;
  timezone: string;
  durationMinutes?: number;
  tags?: string[];
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const [row] = await db
    .insert(tasks)
    .values({
      userId: input.userId,
      title: input.title.trim(),
      description: input.description?.trim(),
      scheduledAt: new Date(input.scheduledAt),
      timezone: input.timezone,
      durationMinutes: input.durationMinutes ?? 30,
      tags: input.tags ?? []
    })
    .returning();

  if (!row) throw new Error("createTask returned no row");
  logger.info({ userId: input.userId, taskId: row.id }, "Task created");
  return mapTask(row);
}

export async function getTaskById(
  userId: string,
  taskId: string
): Promise<Task | null> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)))
    .limit(1);
  return row ? mapTask(row) : null;
}

export interface FindTasksFilter {
  userId: string;
  dateRangeStart?: string;
  dateRangeEnd?: string;
  status?: TaskStatus | "any";
  limit?: number;
}

export async function findTasks(filter: FindTasksFilter): Promise<Task[]> {
  const {
    userId,
    dateRangeStart,
    dateRangeEnd,
    status = "any",
    limit = 50
  } = filter;

  const where = [eq(tasks.userId, userId)];
  if (dateRangeStart) {
    where.push(gte(tasks.scheduledAt, new Date(dateRangeStart)));
  }
  if (dateRangeEnd) {
    where.push(lte(tasks.scheduledAt, new Date(dateRangeEnd)));
  }
  if (status !== "any") {
    where.push(eq(tasks.status, status));
  }

  const rows = await db
    .select()
    .from(tasks)
    .where(and(...where))
    .orderBy(asc(tasks.scheduledAt))
    .limit(limit);

  return rows.map(mapTask);
}

export async function updateTask(
  userId: string,
  taskId: string,
  patch: Partial<Omit<Task, "id" | "userId" | "createdAt">>
): Promise<Task | null> {
  const updateValues: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) updateValues.title = patch.title;
  if (patch.description !== undefined)
    updateValues.description = patch.description;
  if (patch.scheduledAt !== undefined)
    updateValues.scheduledAt = new Date(patch.scheduledAt);
  if (patch.durationMinutes !== undefined)
    updateValues.durationMinutes = patch.durationMinutes;
  if (patch.status !== undefined) updateValues.status = patch.status;
  if (patch.tags !== undefined) updateValues.tags = patch.tags;
  if (patch.timezone !== undefined) updateValues.timezone = patch.timezone;

  const [row] = await db
    .update(tasks)
    .set(updateValues)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)))
    .returning();

  if (!row) return null;
  logger.info(
    { userId, taskId, fields: Object.keys(patch) },
    "Task updated"
  );
  return mapTask(row);
}

export async function deleteTask(
  userId: string,
  taskId: string
): Promise<boolean> {
  const rows = await db
    .delete(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)))
    .returning({ id: tasks.id });
  const deleted = rows.length > 0;
  if (deleted) logger.info({ userId, taskId }, "Task deleted");
  return deleted;
}

/**
 * Counts tasks in a date range for quick agenda lookups (not yet used by
 * an LLM tool but useful for dashboard widgets / analytics).
 */
export async function countTasksInRange(
  userId: string,
  start: string,
  end: string
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        gte(tasks.scheduledAt, new Date(start)),
        lte(tasks.scheduledAt, new Date(end))
      )
    );
  return row?.count ?? 0;
}

// ---- mapper: db row → domain type ----

function mapTask(row: DbTask): Task {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    description: row.description ?? undefined,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    durationMinutes: row.durationMinutes,
    status: row.status as TaskStatus,
    tags: row.tags,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}
