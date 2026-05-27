import { describe, expect, it, beforeEach, vi } from "vitest";
import { Session } from "../orchestrator/session.js";

describe("Session", () => {
  let s: Session;

  beforeEach(() => {
    s = new Session("sess-1", "user:abc", "en", "Europe/Berlin", "Hammad");
  });

  it("starts in IDLE state with empty memory", () => {
    expect(s.state).toBe("IDLE");
    expect(s.history).toEqual([]);
    expect(s.referenced).toEqual([]);
    expect(s.pending).toBeNull();
  });

  it("trims conversation history to MAX_HISTORY", () => {
    // Push 50 turns; only the last 30 should remain.
    for (let i = 0; i < 50; i++) {
      s.pushTurn({
        role: "user",
        content: `msg ${i}`,
        timestamp: new Date().toISOString()
      });
    }
    expect(s.history).toHaveLength(30);
    expect(s.history[0]?.content).toBe("msg 20");
    expect(s.history[29]?.content).toBe("msg 49");
  });

  describe("noteReference", () => {
    it("places newest reference at the front", () => {
      s.noteReference("t1", "Workout");
      s.noteReference("t2", "LinkedIn post");
      expect(s.referenced[0]?.taskId).toBe("t2");
      expect(s.referenced[1]?.taskId).toBe("t1");
    });

    it("dedupes — same task moved to front, not duplicated", () => {
      s.noteReference("t1", "Workout");
      s.noteReference("t2", "LinkedIn post");
      s.noteReference("t1", "Workout (re-mentioned)");
      expect(s.referenced).toHaveLength(2);
      expect(s.referenced[0]?.taskId).toBe("t1");
      expect(s.referenced[0]?.mentionedAs).toBe("Workout (re-mentioned)");
    });

    it("caps at MAX_REFERENCED (8)", () => {
      for (let i = 0; i < 20; i++) {
        s.noteReference(`t${i}`, `Task ${i}`);
      }
      expect(s.referenced).toHaveLength(8);
      // Newest first → t19 at index 0
      expect(s.referenced[0]?.taskId).toBe("t19");
    });
  });

  describe("replaceReferenceList", () => {
    it("replaces and preserves order for ordinal references", () => {
      s.replaceReferenceList([
        { taskId: "a", mentionedAs: "Product sync" },
        { taskId: "b", mentionedAs: "LinkedIn post" }
      ]);
      expect(s.referenced.map((r) => r.taskId)).toEqual(["a", "b"]);
    });
  });

  describe("pending confirmations", () => {
    it("expires after TTL", () => {
      vi.useFakeTimers();
      s.setPending({
        action: "delete",
        taskIds: ["t1"],
        summary: "Workout"
      });
      expect(s.pending).not.toBeNull();

      vi.advanceTimersByTime(31_000);
      s.expireStalePending();
      expect(s.pending).toBeNull();

      vi.useRealTimers();
    });

    it("stays valid before TTL", () => {
      vi.useFakeTimers();
      s.setPending({
        action: "delete",
        taskIds: ["t1"],
        summary: "Workout"
      });
      vi.advanceTimersByTime(10_000);
      s.expireStalePending();
      expect(s.pending).not.toBeNull();
      vi.useRealTimers();
    });
  });

  describe("abortInflight", () => {
    it("aborts the current controller and clears the slot", () => {
      const controller = new AbortController();
      s.currentAbort = controller;
      s.abortInflight();
      expect(controller.signal.aborted).toBe(true);
      expect(s.currentAbort).toBeNull();
    });

    it("is a no-op when no controller is set", () => {
      expect(() => s.abortInflight()).not.toThrow();
    });
  });
});
