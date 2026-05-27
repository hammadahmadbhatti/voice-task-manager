/**
 * LLM tool (function-calling) schemas.
 *
 * We define them in zod once and derive both:
 *   1. The OpenAI tool spec (passed to chat.completions)
 *   2. The runtime validator (used to parse the model's arguments)
 *
 * Why zod-first: lets us reject malformed tool calls with helpful errors
 * before they hit DynamoDB, and avoids the eternal "hand-written JSON schema
 * drifting from the runtime parser" problem.
 */

import { z } from "zod";

// ---------- Argument schemas ----------

export const CreateTaskArgs = z.object({
  title: z.string().min(1).max(200).describe(
    "Short imperative title of the task, in the user's language. " +
      "E.g. 'Sync with product manager', 'Gym workout', 'LinkedIn post'."
  ),
  scheduledAt: z
    .string()
    .datetime({ offset: true })
    .describe(
      "Absolute datetime in ISO 8601 with timezone offset, e.g. " +
        "'2026-05-26T17:00:00+02:00'. Resolve relative references " +
        "like 'tomorrow morning' using the CURRENT_DATETIME and USER_TIMEZONE " +
        "in the system context. Defaults: morning=08:00, afternoon=14:00, " +
        "evening=18:00, night=21:00, when no specific time is given."
    ),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(8 * 60)
    .default(30)
    .describe("Duration in minutes. Default 30 if not stated."),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string().max(30)).max(10).default([])
});
export type CreateTaskArgs = z.infer<typeof CreateTaskArgs>;

export const FindTasksArgs = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Free-text semantic query, e.g. 'evening workout', 'LinkedIn post'. " +
        "Used for fuzzy matching of titles. Leave empty when the user is " +
        "asking for a date-range listing like 'tasks today'."
    ),
  dateRangeStart: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("ISO 8601 inclusive lower bound for scheduledAt."),
  dateRangeEnd: z
    .string()
    .datetime({ offset: true })
    .optional()
    .describe("ISO 8601 inclusive upper bound for scheduledAt."),
  timeOfDay: z
    .enum(["morning", "afternoon", "evening", "night", "any"])
    .default("any")
    .describe(
      "Coarse time-of-day filter. morning=05:00–11:59, afternoon=12:00–16:59, " +
        "evening=17:00–20:59, night=21:00–04:59 (in user's timezone)."
    ),
  status: z.enum(["pending", "done", "cancelled", "any"]).default("pending"),
  limit: z.number().int().min(1).max(50).default(20)
});
export type FindTasksArgs = z.infer<typeof FindTasksArgs>;

export const UpdateTaskArgs = z.object({
  taskId: z
    .string()
    .describe(
      "Exact task ID. Obtain by first calling find_tasks if the user used a " +
        "natural reference like 'the LinkedIn one' or 'the previous one'."
    ),
  title: z.string().min(1).max(200).optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  durationMinutes: z.number().int().min(5).max(8 * 60).optional(),
  status: z.enum(["pending", "done", "cancelled"]).optional(),
  description: z.string().max(1000).optional(),
  tags: z.array(z.string()).optional()
});
export type UpdateTaskArgs = z.infer<typeof UpdateTaskArgs>;

export const DeleteTaskArgs = z.object({
  taskId: z.string().describe("Exact task ID to delete."),
  /**
   * Server-side guard: the model must set confirmed=true ONLY after the user
   * has explicitly said yes in the immediately preceding turn. The state
   * machine double-checks this — if confirmed=false, the tool stages a
   * confirmation rather than deleting.
   */
  confirmed: z
    .boolean()
    .default(false)
    .describe(
      "Set true ONLY if the user has just explicitly confirmed deletion in " +
        "the previous turn. Otherwise leave false to trigger a confirmation prompt."
    )
});
export type DeleteTaskArgs = z.infer<typeof DeleteTaskArgs>;

export const RequestClarificationArgs = z.object({
  question: z
    .string()
    .describe(
      "A specific clarifying question to ask the user, in their language. " +
        "Use when a reference is ambiguous (e.g. multiple tasks match)."
    ),
  candidates: z
    .array(
      z.object({
        taskId: z.string(),
        label: z.string()
      })
    )
    .optional()
    .describe("Optional candidates to offer the user.")
});
export type RequestClarificationArgs = z.infer<typeof RequestClarificationArgs>;

// ---------- Tool registry ----------

export const TOOL_NAMES = [
  "create_task",
  "find_tasks",
  "update_task",
  "delete_task",
  "request_clarification"
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_SCHEMAS = {
  create_task: CreateTaskArgs,
  find_tasks: FindTasksArgs,
  update_task: UpdateTaskArgs,
  delete_task: DeleteTaskArgs,
  request_clarification: RequestClarificationArgs
} as const;

// ---------- OpenAI tool spec generation ----------

/**
 * Manually-curated OpenAI tool specs. We hand-write the JSON Schema for these
 * (rather than auto-converting from zod) because OpenAI's function-calling
 * spec doesn't accept every zod feature, and the manual version gives us
 * cleaner descriptions that the model actually reads.
 */
export const OPENAI_TOOL_SPECS = [
  {
    type: "function" as const,
    function: {
      name: "create_task",
      description:
        "Create a new task on the user's calendar. Use this when the user asks to schedule, add, or create something.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "Short imperative title in the user's language (e.g. 'Sync with PM', 'Post on LinkedIn')."
          },
          scheduledAt: {
            type: "string",
            description:
              "ISO 8601 datetime with timezone offset. Resolve relative phrases using CURRENT_DATETIME and USER_TIMEZONE from the system context. Defaults when only time-of-day is given: morning=08:00, afternoon=14:00, evening=18:00, night=21:00."
          },
          durationMinutes: {
            type: "integer",
            minimum: 5,
            maximum: 480,
            description: "Duration in minutes. Default 30."
          },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } }
        },
        required: ["title", "scheduledAt"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "find_tasks",
      description:
        "Search the user's tasks. Use for read requests AND as a lookup step before update/delete when the user references a task by description rather than ID.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Free-text semantic query for fuzzy title matching (e.g. 'evening workout'). Omit when listing by date only."
          },
          dateRangeStart: {
            type: "string",
            description: "ISO 8601 inclusive lower bound."
          },
          dateRangeEnd: {
            type: "string",
            description: "ISO 8601 inclusive upper bound."
          },
          timeOfDay: {
            type: "string",
            enum: ["morning", "afternoon", "evening", "night", "any"],
            description:
              "Coarse filter: morning 05–11:59, afternoon 12–16:59, evening 17–20:59, night 21–04:59."
          },
          status: {
            type: "string",
            enum: ["pending", "done", "cancelled", "any"]
          },
          limit: { type: "integer", minimum: 1, maximum: 50 }
        },
        required: []
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "update_task",
      description:
        "Update fields of an existing task. taskId is required — if you don't have one, call find_tasks first.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          title: { type: "string" },
          scheduledAt: { type: "string" },
          durationMinutes: { type: "integer", minimum: 5, maximum: 480 },
          status: {
            type: "string",
            enum: ["pending", "done", "cancelled"]
          },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } }
        },
        required: ["taskId"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "delete_task",
      description:
        "Delete a task. DESTRUCTIVE: only set confirmed=true after the user has explicitly said yes in the immediately preceding turn. Otherwise set confirmed=false to stage a confirmation prompt.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          confirmed: {
            type: "boolean",
            description:
              "true ONLY if the user has just explicitly confirmed deletion. Default false."
          }
        },
        required: ["taskId"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "request_clarification",
      description:
        "Ask the user a clarifying question when a reference is ambiguous (multiple matching tasks, vague description, etc.). Prefer this over guessing.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          candidates: {
            type: "array",
            items: {
              type: "object",
              properties: {
                taskId: { type: "string" },
                label: { type: "string" }
              },
              required: ["taskId", "label"]
            }
          }
        },
        required: ["question"]
      }
    }
  }
];
