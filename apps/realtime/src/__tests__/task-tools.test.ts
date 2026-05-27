import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Task } from "@vtm/shared";

// Mock the DB layer BEFORE importing the module under test.
vi.mock("../db/tasks-repo.js", () => ({
  createTask: vi.fn(),
  findTasks: vi.fn(),
  getTaskById: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn()
}));

import * as repo from "../db/tasks-repo.js";
import { Session } from "../orchestrator/session.js";
import { executeTool } from "../agents/task-tools.js";

const baseTask: Task = {
  id: "01HSAMPLEID",
  userId: "user:abc",
  title: "Product sync",
  scheduledAt: "2026-05-26T16:00:00.000Z",
  timezone: "Europe/Berlin",
  durationMinutes: 30,
  status: "pending",
  tags: [],
  createdAt: "2026-05-26T10:00:00.000Z",
  updatedAt: "2026-05-26T10:00:00.000Z"
};

function newSession() {
  return new Session("sess-1", "user:abc", "en", "Europe/Berlin");
}

describe("executeTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("create_task", () => {
    it("creates a task and notes it in working memory", async () => {
      vi.mocked(repo.createTask).mockResolvedValue(baseTask);
      const session = newSession();

      const result = await executeTool(
        "create_task",
        JSON.stringify({
          title: "Product sync",
          scheduledAt: "2026-05-26T18:00:00+02:00"
        }),
        { session }
      );

      expect(result.ok).toBe(true);
      expect(result.taskEvent?.action).toBe("created");
      expect(session.referenced[0]?.taskId).toBe(baseTask.id);
      expect(repo.createTask).toHaveBeenCalledOnce();
    });

    it("rejects missing required fields", async () => {
      const result = await executeTool(
        "create_task",
        JSON.stringify({ title: "no time" }),
        { session: newSession() }
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/Invalid arguments/i);
      expect(repo.createTask).not.toHaveBeenCalled();
    });

    it("rejects malformed JSON", async () => {
      const result = await executeTool("create_task", "{not json", {
        session: newSession()
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("find_tasks", () => {
    it("filters by time-of-day in user's timezone", async () => {
      const morning: Task = { ...baseTask, id: "m", scheduledAt: "2026-05-26T07:00:00+02:00" };
      const evening: Task = { ...baseTask, id: "e", scheduledAt: "2026-05-26T19:00:00+02:00" };
      vi.mocked(repo.findTasks).mockResolvedValue([morning, evening]);

      const result = await executeTool(
        "find_tasks",
        JSON.stringify({ timeOfDay: "evening" }),
        { session: newSession() }
      );

      expect(result.ok).toBe(true);
      const data = result.data as { tasks: { id: string }[] };
      expect(data.tasks.map((t) => t.id)).toEqual(["e"]);
    });

    it("applies fuzzy matching when query is given", async () => {
      vi.mocked(repo.findTasks).mockResolvedValue([
        { ...baseTask, id: "1", title: "LinkedIn post" },
        { ...baseTask, id: "2", title: "Gym workout" },
        { ...baseTask, id: "3", title: "Buy groceries" }
      ]);

      const result = await executeTool(
        "find_tasks",
        JSON.stringify({ query: "linkedin" }),
        { session: newSession() }
      );

      const data = result.data as { tasks: { id: string }[] };
      expect(data.tasks[0]?.id).toBe("1");
    });

    it("updates the session's reference list for ordinal lookups", async () => {
      vi.mocked(repo.findTasks).mockResolvedValue([
        { ...baseTask, id: "1", title: "First" },
        { ...baseTask, id: "2", title: "Second" }
      ]);
      const session = newSession();
      await executeTool("find_tasks", "{}", { session });
      expect(session.referenced.map((r) => r.taskId)).toEqual(["1", "2"]);
    });
  });

  describe("delete_task — confirmation flow", () => {
    it("stages a confirmation on first call (confirmed=false)", async () => {
      vi.mocked(repo.getTaskById).mockResolvedValue(baseTask);
      const session = newSession();

      const result = await executeTool(
        "delete_task",
        JSON.stringify({ taskId: baseTask.id }),
        { session }
      );

      expect(result.ok).toBe(true);
      expect(result.haltAfter).toBe(true);
      expect(result.speakDirectly).toMatch(/sure/i);
      expect(session.pending?.action).toBe("delete");
      expect(session.pending?.taskIds).toContain(baseTask.id);
      expect(repo.deleteTask).not.toHaveBeenCalled();
    });

    it("REFUSES to delete even with confirmed=true if no session pending", async () => {
      // Defense in depth — even a confused LLM can't bypass the state machine.
      vi.mocked(repo.getTaskById).mockResolvedValue(baseTask);
      const session = newSession();
      // No setPending — session.pending is null

      const result = await executeTool(
        "delete_task",
        JSON.stringify({ taskId: baseTask.id, confirmed: true }),
        { session }
      );

      expect(result.ok).toBe(true);
      expect(result.haltAfter).toBe(true);
      expect(result.speakDirectly).toMatch(/sure/i);
      expect(repo.deleteTask).not.toHaveBeenCalled();
    });

    it("executes when both confirmed=true AND session has matching pending", async () => {
      vi.mocked(repo.getTaskById).mockResolvedValue(baseTask);
      vi.mocked(repo.deleteTask).mockResolvedValue(true);

      const session = newSession();
      session.setPending({
        action: "delete",
        taskIds: [baseTask.id],
        summary: baseTask.title
      });

      const result = await executeTool(
        "delete_task",
        JSON.stringify({ taskId: baseTask.id, confirmed: true }),
        { session }
      );

      expect(result.ok).toBe(true);
      expect(result.haltAfter).toBeUndefined();
      expect(result.taskEvent?.action).toBe("deleted");
      expect(session.pending).toBeNull();
      expect(repo.deleteTask).toHaveBeenCalledWith(session.userId, baseTask.id);
    });

    it("uses German confirmation prompt when locale=de", async () => {
      vi.mocked(repo.getTaskById).mockResolvedValue(baseTask);
      const session = new Session("s", "user:abc", "de", "Europe/Berlin");
      const result = await executeTool(
        "delete_task",
        JSON.stringify({ taskId: baseTask.id }),
        { session }
      );
      expect(result.speakDirectly).toMatch(/wirklich löschen/);
    });

    it("returns error for non-existent task", async () => {
      vi.mocked(repo.getTaskById).mockResolvedValue(null);
      const result = await executeTool(
        "delete_task",
        JSON.stringify({ taskId: "ghost" }),
        { session: newSession() }
      );
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/no task found/i);
    });
  });

  describe("update_task", () => {
    it("rejects updates to non-existent tasks", async () => {
      vi.mocked(repo.getTaskById).mockResolvedValue(null);
      const result = await executeTool(
        "update_task",
        JSON.stringify({ taskId: "ghost", title: "new" }),
        { session: newSession() }
      );
      expect(result.ok).toBe(false);
    });

    it("returns a task_event hint for the UI", async () => {
      vi.mocked(repo.getTaskById).mockResolvedValue(baseTask);
      vi.mocked(repo.updateTask).mockResolvedValue({
        ...baseTask,
        title: "renamed"
      });

      const result = await executeTool(
        "update_task",
        JSON.stringify({ taskId: baseTask.id, title: "renamed" }),
        { session: newSession() }
      );
      expect(result.taskEvent?.action).toBe("updated");
    });
  });

  describe("request_clarification", () => {
    it("halts the loop and registers candidates as references", async () => {
      const session = newSession();
      const result = await executeTool(
        "request_clarification",
        JSON.stringify({
          question: "Did you mean A or B?",
          candidates: [
            { taskId: "a", label: "A" },
            { taskId: "b", label: "B" }
          ]
        }),
        { session }
      );
      expect(result.ok).toBe(true);
      expect(result.haltAfter).toBe(true);
      expect(result.speakDirectly).toBe("Did you mean A or B?");
      expect(session.referenced.map((r) => r.taskId)).toEqual(["a", "b"]);
    });
  });

  it("returns error for unknown tool name", async () => {
    const result = await executeTool("teleport", "{}", {
      session: newSession()
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown tool/i);
  });
});
