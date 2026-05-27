import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  computeCalendarContext
} from "../prompts/system.js";

describe("buildSystemPrompt", () => {
  const base = {
    currentDateTime: "2026-05-26T17:30:00+02:00",
    timezone: "Europe/Berlin",
    recentlyReferenced: [],
    pendingConfirmation: null
  };

  it("injects current datetime and timezone", () => {
    const out = buildSystemPrompt({ ...base, locale: "en" });
    expect(out).toContain("2026-05-26T17:30:00+02:00");
    expect(out).toContain("Europe/Berlin");
  });

  it("uses English voice-first instructions by default", () => {
    const out = buildSystemPrompt({ ...base, locale: "en" });
    expect(out).toMatch(/voice-first/i);
    expect(out).toMatch(/NEVER use markdown/i);
  });

  it("switches to German prose when locale=de", () => {
    const out = buildSystemPrompt({ ...base, locale: "de" });
    expect(out).toMatch(/sprachgesteuerter/i);
    expect(out).toMatch(/Vorgehen/);
  });

  it("renders working memory list", () => {
    const out = buildSystemPrompt({
      ...base,
      locale: "en",
      recentlyReferenced: [
        { taskId: "01H1", lastMentioned: 2, mentionedAs: "LinkedIn post" },
        { taskId: "01H2", lastMentioned: 1, mentionedAs: "Workout" }
      ]
    });
    expect(out).toContain("01H1");
    expect(out).toContain("LinkedIn post");
    expect(out).toContain("Workout");
  });

  it("shows '(empty)' when nothing is referenced", () => {
    const out = buildSystemPrompt({ ...base, locale: "en" });
    expect(out).toMatch(/empty.*no tasks referenced/i);
  });

  it("highlights pending confirmation with yes/no vocabulary", () => {
    const out = buildSystemPrompt({
      ...base,
      locale: "en",
      pendingConfirmation: {
        action: "delete",
        taskIds: ["t1"],
        summary: "Gym workout",
        expiresAt: Date.now() + 10_000
      }
    });
    expect(out).toMatch(/PENDING_CONFIRMATION: delete/);
    expect(out).toMatch(/yes\/ja/);
  });

  it("includes the user's name when provided", () => {
    const out = buildSystemPrompt({
      ...base,
      locale: "en",
      userName: "Hammad"
    });
    expect(out).toContain("Hammad");
  });

  it("injects pre-resolved calendar with weekday names", () => {
    const out = buildSystemPrompt({ ...base, locale: "en" });
    // 2026-05-26 is a Tuesday
    expect(out).toMatch(/TODAY:\s+Tuesday, 2026-05-26/);
    expect(out).toMatch(/TOMORROW:\s+Wednesday, 2026-05-27/);
    // ISO week containing 2026-05-26: Mon May 25 → Sun May 31
    expect(out).toMatch(/THIS_WEEK:\s+Monday 2026-05-25 — Sunday 2026-05-31/);
    expect(out).toMatch(/NEXT_WEEK:\s+Monday 2026-06-01 — Sunday 2026-06-07/);
  });
});

describe("computeCalendarContext", () => {
  it("resolves TODAY and TOMORROW with weekday names in the user's timezone", () => {
    const c = computeCalendarContext(
      "2026-05-26T17:30:00+02:00",
      "Europe/Berlin",
      "en"
    );
    expect(c.today).toBe("Tuesday, 2026-05-26");
    expect(c.tomorrow).toBe("Wednesday, 2026-05-27");
    expect(c.yesterday).toBe("Monday, 2026-05-25");
    expect(c.todayDayName).toBe("Tuesday");
  });

  it("computes the ISO week (Mon → Sun) regardless of which day we're on", () => {
    // Sunday 2026-05-31 should still belong to the Mon 25 → Sun 31 week.
    const c = computeCalendarContext(
      "2026-05-31T10:00:00+02:00",
      "Europe/Berlin",
      "en"
    );
    expect(c.thisWeek).toContain("Monday 2026-05-25");
    expect(c.thisWeek).toContain("Sunday 2026-05-31");
  });

  it("returns weekday names in German for de locale", () => {
    const c = computeCalendarContext(
      "2026-05-26T17:30:00+02:00",
      "Europe/Berlin",
      "de"
    );
    expect(c.todayDayName).toBe("Dienstag");
    expect(c.today).toMatch(/Dienstag/);
  });
});
