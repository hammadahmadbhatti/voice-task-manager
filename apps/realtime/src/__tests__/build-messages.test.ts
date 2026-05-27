/**
 * Regression tests for buildMessages — the function that translates session
 * history into OpenAI chat-completion messages.
 *
 * Bug history: when the LLM emitted multiple parallel tool_calls (e.g.
 * "create three tasks"), all three tool responses got pushed to history
 * with only the tool name. buildMessages then matched each result to the
 * SAME (first) tool_call_id by name, leaving the other IDs unanswered →
 * OpenAI 400 "tool_call_ids did not have response messages".
 *
 * These tests pin the new contract: each tool turn carries its own
 * `toolCallId`, and buildMessages emits one tool message per call.
 */

import { describe, expect, it } from "vitest";
import { Session } from "../orchestrator/session.js";
import { buildMessages } from "../orchestrator/conversation-agent.js";

function newSession(): Session {
  return new Session("s", "user:x", "en", "Europe/Berlin");
}

describe("buildMessages", () => {
  it("includes the system prompt", () => {
    const session = newSession();
    const messages = buildMessages(session);
    expect(messages[0]?.role).toBe("system");
  });

  it("preserves a simple user → assistant exchange", () => {
    const session = newSession();
    session.pushTurn({
      role: "user",
      content: "Hello",
      timestamp: new Date().toISOString()
    });
    session.pushTurn({
      role: "assistant",
      content: "Hi there.",
      timestamp: new Date().toISOString()
    });

    const messages = buildMessages(session);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  /**
   * THE BUG: emit three parallel tool calls. Each response must reference
   * its own tool_call_id. Old code wrote the same id for all three.
   */
  it("emits one tool message per parallel tool_call with distinct IDs", () => {
    const session = newSession();

    session.pushTurn({
      role: "user",
      content: "Create three tasks for tomorrow morning",
      timestamp: new Date().toISOString()
    });
    session.pushTurn({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_a", name: "create_task", arguments: { title: "Gym" } },
        { id: "call_b", name: "create_task", arguments: { title: "Sync" } },
        { id: "call_c", name: "create_task", arguments: { title: "Post" } }
      ],
      timestamp: new Date().toISOString()
    });
    // Each tool result records its own tool_call_id.
    for (const id of ["call_a", "call_b", "call_c"]) {
      session.pushTurn({
        role: "tool",
        toolName: "create_task",
        toolCallId: id,
        content: JSON.stringify({ ok: true, data: { id: "t" + id } }),
        timestamp: new Date().toISOString()
      });
    }

    const messages = buildMessages(session);
    const toolMsgs = messages.filter((m) => m.role === "tool") as Array<{
      role: "tool";
      tool_call_id: string;
    }>;

    expect(toolMsgs).toHaveLength(3);
    expect(toolMsgs.map((m) => m.tool_call_id).sort()).toEqual([
      "call_a",
      "call_b",
      "call_c"
    ]);
  });

  /**
   * Defensive case: if an interruption left history with an assistant turn
   * whose tool_calls weren't all answered, OpenAI 400s. We drop the
   * orphaned assistant turn rather than send it.
   */
  it("drops assistant turns with orphaned tool_calls", () => {
    const session = newSession();
    session.pushTurn({
      role: "user",
      content: "x",
      timestamp: new Date().toISOString()
    });
    session.pushTurn({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "answered", name: "find_tasks", arguments: {} },
        { id: "orphan", name: "find_tasks", arguments: {} }
      ],
      timestamp: new Date().toISOString()
    });
    session.pushTurn({
      role: "tool",
      toolName: "find_tasks",
      toolCallId: "answered",
      content: "{}",
      timestamp: new Date().toISOString()
    });
    // No response for "orphan" — interruption case.
    session.pushTurn({
      role: "user",
      content: "actually never mind",
      timestamp: new Date().toISOString()
    });

    const messages = buildMessages(session);
    // The orphaned assistant + its partial tool response should both be dropped.
    expect(messages.some((m) => m.role === "tool")).toBe(false);
    const assistantTurns = messages.filter((m) => m.role === "assistant");
    expect(assistantTurns).toHaveLength(0);
    // Both user turns should survive.
    expect(messages.filter((m) => m.role === "user")).toHaveLength(2);
  });

  /**
   * Real-world scenario: MAX_HISTORY=30 trim sliced off the declaring
   * assistant turn but kept its tool messages. OpenAI 400s at
   * messages.[1].role if we forward those naked tool turns. We must drop them.
   */
  it("drops orphan tool turns whose declaring assistant was spliced", () => {
    const session = newSession();
    // Simulate post-splice history: tool turn is the very first entry.
    session.history.push(
      {
        role: "tool",
        toolName: "create_task",
        toolCallId: "call_spliced_away",
        content: JSON.stringify({ ok: true }),
        timestamp: new Date().toISOString()
      },
      {
        role: "user",
        content: "what's next?",
        timestamp: new Date().toISOString()
      }
    );

    const messages = buildMessages(session);
    // No tool message should leak through.
    expect(messages.some((m) => m.role === "tool")).toBe(false);
    // The user turn must still pass through.
    expect(messages.some((m) => m.role === "user")).toBe(true);
    // First non-system message must NOT be a tool message — that's the
    // exact invariant OpenAI enforces.
    const firstNonSystem = messages.find((m) => m.role !== "system");
    expect(firstNonSystem?.role).not.toBe("tool");
  });

  it("ignores tool turns missing a toolCallId (legacy history safety)", () => {
    const session = newSession();
    session.pushTurn({
      role: "user",
      content: "x",
      timestamp: new Date().toISOString()
    });
    session.pushTurn({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "valid", name: "find_tasks", arguments: {} }],
      timestamp: new Date().toISOString()
    });
    session.pushTurn({
      role: "tool",
      toolName: "find_tasks",
      // toolCallId omitted — legacy history before the fix
      content: "{}",
      timestamp: new Date().toISOString()
    });

    const messages = buildMessages(session);
    // The orphaned-assistant filter should kick in since no tool response was
    // emitted for "valid".
    expect(messages.some((m) => m.role === "tool")).toBe(false);
  });
});
