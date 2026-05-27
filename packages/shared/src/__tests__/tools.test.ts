import { describe, expect, it } from "vitest";
import {
  CreateTaskArgs,
  DeleteTaskArgs,
  FindTasksArgs,
  UpdateTaskArgs,
  OPENAI_TOOL_SPECS,
  TOOL_NAMES
} from "../schemas/tools.js";

describe("Tool argument schemas", () => {
  describe("CreateTaskArgs", () => {
    it("accepts valid input", () => {
      const r = CreateTaskArgs.safeParse({
        title: "Sync with PM",
        scheduledAt: "2026-05-26T10:00:00+02:00"
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.durationMinutes).toBe(30); // default
        expect(r.data.tags).toEqual([]); // default
      }
    });

    it("rejects missing scheduledAt", () => {
      const r = CreateTaskArgs.safeParse({ title: "no time" });
      expect(r.success).toBe(false);
    });

    it("rejects datetime without offset", () => {
      const r = CreateTaskArgs.safeParse({
        title: "x",
        scheduledAt: "2026-05-26T10:00:00" // no Z, no offset
      });
      expect(r.success).toBe(false);
    });

    it("rejects insanely long durations", () => {
      const r = CreateTaskArgs.safeParse({
        title: "x",
        scheduledAt: "2026-05-26T10:00:00+02:00",
        durationMinutes: 24 * 60 // 1 day — over the 8h cap
      });
      expect(r.success).toBe(false);
    });
  });

  describe("FindTasksArgs", () => {
    it("defaults to any/status=pending/limit=20", () => {
      const r = FindTasksArgs.safeParse({});
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.timeOfDay).toBe("any");
        expect(r.data.status).toBe("pending");
        expect(r.data.limit).toBe(20);
      }
    });

    it("rejects invalid time-of-day enum", () => {
      const r = FindTasksArgs.safeParse({ timeOfDay: "twilight" });
      expect(r.success).toBe(false);
    });

    it("rejects limit out of range", () => {
      expect(FindTasksArgs.safeParse({ limit: 0 }).success).toBe(false);
      expect(FindTasksArgs.safeParse({ limit: 51 }).success).toBe(false);
    });
  });

  describe("UpdateTaskArgs", () => {
    it("requires taskId", () => {
      const r = UpdateTaskArgs.safeParse({ title: "new" });
      expect(r.success).toBe(false);
    });
  });

  describe("DeleteTaskArgs", () => {
    it("defaults confirmed to false", () => {
      const r = DeleteTaskArgs.safeParse({ taskId: "t1" });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.confirmed).toBe(false);
      }
    });

    it("accepts explicit confirmed=true", () => {
      const r = DeleteTaskArgs.safeParse({ taskId: "t1", confirmed: true });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.confirmed).toBe(true);
    });
  });
});

describe("OPENAI_TOOL_SPECS", () => {
  it("matches the tool name registry", () => {
    const specNames = OPENAI_TOOL_SPECS.map((s) => s.function.name).sort();
    const registryNames = [...TOOL_NAMES].sort();
    expect(specNames).toEqual(registryNames);
  });

  it("declares scheduledAt as required for create_task", () => {
    const create = OPENAI_TOOL_SPECS.find(
      (s) => s.function.name === "create_task"
    );
    expect(create?.function.parameters.required).toContain("scheduledAt");
    expect(create?.function.parameters.required).toContain("title");
  });

  it("declares taskId as required for delete_task", () => {
    const del = OPENAI_TOOL_SPECS.find(
      (s) => s.function.name === "delete_task"
    );
    expect(del?.function.parameters.required).toContain("taskId");
  });
});
