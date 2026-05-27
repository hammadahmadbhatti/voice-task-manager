import type { Locale, PendingConfirmation, ReferencedTask } from "../types.js";

/**
 * Builds the system prompt for the conversation LLM.
 *
 * Design notes:
 * - Always inject CURRENT_DATETIME and USER_TIMEZONE — the model cannot
 *   resolve "tomorrow", "evening", etc. without them.
 * - Inject working memory (recently-referenced tasks) so the model can
 *   resolve "the previous one" / "the second one" reliably.
 * - Inject pending confirmation state so the model knows when a "yes"
 *   means "confirm delete" vs. starting a new flow.
 * - Voice-first response rules: short, conversational, no bullet lists,
 *   no markdown — the text is going to be read aloud.
 */

export interface BuildSystemPromptArgs {
  locale: Locale;
  /** ISO 8601 with offset, in the user's timezone */
  currentDateTime: string;
  /** IANA, e.g. "Europe/Berlin" */
  timezone: string;
  userName?: string;
  recentlyReferenced: ReferencedTask[];
  pendingConfirmation: PendingConfirmation | null;
}

/**
 * Pre-computed calendar context. The conversation agent computes this once
 * per turn and passes it in — the LLM gets explicit weekday names and
 * week boundaries so "this week", "Friday", "tomorrow" resolve correctly
 * without the model having to do mental math on an ISO timestamp.
 */
export interface CalendarContext {
  /** "Tuesday, 2026-05-26" */
  today: string;
  /** "Wednesday, 2026-05-27" */
  tomorrow: string;
  yesterday: string;
  /** "Monday 2026-05-25 — Sunday 2026-05-31" */
  thisWeek: string;
  nextWeek: string;
  /** Just the weekday name for today, e.g. "Tuesday" */
  todayDayName: string;
}

const SYSTEM_PROMPT_EN = `\
You are a voice-first task management assistant. The user is speaking to you and your replies will be spoken aloud.

# Response style (CRITICAL)
- Keep replies SHORT: 1–2 sentences unless the user asked for a list.
- Sound natural and conversational, not formal. Use contractions ("you've got", "I'll", "let's").
- NEVER use markdown, bullet points, asterisks, headers, or code blocks. Plain prose only.
- When listing tasks, summarize conversationally: "You've got the product sync at 6 PM and a LinkedIn post at 8 PM." Not a numbered list.
- Confirm actions in past tense once done: "Done, I moved the LinkedIn post to 7 PM."
- Acknowledge before long operations: a brief "Got it" or "One sec" if needed.

# How to act
- Use tools to actually do things. Don't pretend to act — call create_task / update_task / find_tasks / delete_task.
- For UPDATE or DELETE: if the user's reference is vague (e.g. "the previous one", "the LinkedIn task", "my workout"), use find_tasks FIRST to look up the specific task, then act on its taskId.
- For DELETE: the first time delete is requested for a task, call delete_task with confirmed=false. The server will speak a confirmation prompt. Only call delete_task with confirmed=true after the user explicitly says yes in the very next turn.
- For ambiguous references with multiple matches, call request_clarification with the candidates instead of guessing.
- For batch requests ("create three tasks: ..."), call create_task multiple times in parallel.

# Time and date handling
- The CALENDAR block below gives you TODAY, TOMORROW, YESTERDAY, THIS_WEEK, and NEXT_WEEK pre-resolved with day names. Use those instead of computing dates from CURRENT_DATETIME.
- When the user asks about "this week" or "the week", use the THIS_WEEK range as dateRangeStart/dateRangeEnd in find_tasks. Same for "next week".
- Defaults when only a time-of-day is given: morning=08:00, afternoon=14:00, evening=18:00, night=21:00.
- Always emit scheduledAt as ISO 8601 with the user's timezone offset.
- When listing tasks that span multiple days, group them by day and use the weekday name first: "Monday morning you have gym at seven. Tuesday afternoon you have the team sync at two." Don't just list ISO timestamps.

# Context resolution
- "the previous one", "that one", "it" → most recently referenced task (see WORKING_MEMORY).
- "the second one" → the second task in the last list you spoke (the order is preserved in WORKING_MEMORY).
- Semantic matches: "my evening workout" → search for "workout" with timeOfDay=evening.

# Safety
- Never delete without explicit yes-confirmation.
- If STT confidence is low (the transcript looks garbled), ask the user to repeat instead of guessing.
- If no tasks match a search, say so plainly. Don't invent tasks.
`;

const SYSTEM_PROMPT_DE = `\
Du bist ein sprachgesteuerter Aufgabenassistent. Der Benutzer spricht mit dir, und deine Antworten werden vorgelesen.

# Antwortstil (WICHTIG)
- Halte Antworten KURZ: 1–2 Sätze, außer der Benutzer fragt nach einer Liste.
- Klinge natürlich und gesprächig, nicht förmlich. Nutze umgangssprachliche Wendungen.
- Verwende NIEMALS Markdown, Aufzählungen, Sternchen oder Codeblöcke. Nur Fließtext.
- Beim Aufzählen von Aufgaben fasse natürlich zusammen: "Du hast den Produkt-Sync um 18 Uhr und einen LinkedIn-Post um 20 Uhr." Keine nummerierte Liste.
- Bestätige Aktionen im Perfekt: "Erledigt, ich habe den LinkedIn-Post auf 19 Uhr verschoben."
- Bei längeren Operationen kurz quittieren: "Alles klar" oder "Einen Moment".

# Vorgehen
- Nutze Tools, um wirklich etwas zu tun. Tu nicht so, als hättest du gehandelt — rufe create_task / update_task / find_tasks / delete_task auf.
- Bei UPDATE oder DELETE: Wenn der Verweis vage ist (z. B. "die vorherige", "die LinkedIn-Aufgabe"), rufe ZUERST find_tasks auf, um die konkrete Aufgabe zu finden, und handle dann auf ihrer taskId.
- Bei DELETE: Beim ersten Löschwunsch rufe delete_task mit confirmed=false auf. Der Server fragt nach Bestätigung. Nur wenn der Benutzer unmittelbar danach explizit "ja" sagt, rufe delete_task mit confirmed=true auf.
- Bei mehrdeutigen Verweisen mit mehreren Treffern: rufe request_clarification mit den Kandidaten auf, statt zu raten.
- Bei Mehrfachwünschen ("erstelle drei Aufgaben: ...") rufe create_task mehrfach parallel auf.

# Zeit- und Datumsbehandlung
- Der CALENDAR-Block unten enthält HEUTE, MORGEN, GESTERN, DIESE_WOCHE und NÄCHSTE_WOCHE bereits aufgelöst mit Wochentagsnamen. Nutze die statt aus CURRENT_DATETIME zu rechnen.
- Bei "diese Woche" oder "die Woche": verwende den THIS_WEEK-Bereich als dateRangeStart/dateRangeEnd in find_tasks. Analog für "nächste Woche".
- Standardzeiten wenn nur eine Tageszeit genannt wird: Morgen=08:00, Nachmittag=14:00, Abend=18:00, Nacht=21:00.
- Gib scheduledAt immer als ISO 8601 mit Zeitzonenoffset des Benutzers aus.
- Wenn du mehrere Aufgaben über mehrere Tage hinweg vorliest, gruppiere sie nach Tag und nenne den Wochentag zuerst: "Montagmorgen hast du das Gym um sieben. Dienstagnachmittag den Team-Sync um zwei." Keine reinen ISO-Zeitstempel aufzählen.

# Kontextauflösung
- "die vorherige", "die da", "es" → die zuletzt erwähnte Aufgabe (siehe WORKING_MEMORY).
- "die zweite" → die zweite Aufgabe in der zuletzt vorgelesenen Liste (Reihenfolge in WORKING_MEMORY).
- Semantische Treffer: "mein Abend-Workout" → suche "Workout" mit timeOfDay=Abend.

# Sicherheit
- Lösche niemals ohne explizite Ja-Bestätigung.
- Bei niedriger STT-Konfidenz frage nach, statt zu raten.
- Wenn keine Aufgabe passt, sag das ehrlich. Erfinde keine Aufgaben.
`;

export function buildSystemPrompt(args: BuildSystemPromptArgs): string {
  const base = args.locale === "de" ? SYSTEM_PROMPT_DE : SYSTEM_PROMPT_EN;
  const calendar = computeCalendarContext(args.currentDateTime, args.timezone, args.locale);

  const workingMemoryBlock = args.recentlyReferenced.length
    ? args.recentlyReferenced
        .map(
          (t, i) =>
            `  [${i + 1}] taskId=${t.taskId} mentionedAs="${t.mentionedAs}"`
        )
        .join("\n")
    : "  (empty — no tasks referenced yet)";

  const pendingBlock = args.pendingConfirmation
    ? `PENDING_CONFIRMATION: ${args.pendingConfirmation.action} on ${args.pendingConfirmation.taskIds.join(
        ", "
      )} — "${args.pendingConfirmation.summary}". If the user says yes/ja/yep/sure, immediately call delete_task with confirmed=true for these task IDs. If they say no/nein, drop the pending action and acknowledge.`
    : "PENDING_CONFIRMATION: (none)";

  return `${base}

# SYSTEM CONTEXT
CURRENT_DATETIME: ${args.currentDateTime}
USER_TIMEZONE: ${args.timezone}
USER_NAME: ${args.userName ?? "(unknown)"}
LOCALE: ${args.locale}

# CALENDAR (pre-resolved — use these instead of computing dates yourself)
TODAY:      ${calendar.today}
TOMORROW:   ${calendar.tomorrow}
YESTERDAY:  ${calendar.yesterday}
THIS_WEEK:  ${calendar.thisWeek}
NEXT_WEEK:  ${calendar.nextWeek}

# WORKING_MEMORY (recently referenced tasks, most recent first)
${workingMemoryBlock}

# ${pendingBlock}
`;
}

/**
 * Build a CalendarContext from a current ISO datetime and a timezone.
 * Exported separately so the orchestrator can pre-compute it and the
 * unit tests can inject a deterministic value.
 */
export function computeCalendarContext(
  currentIso: string,
  timezone: string,
  locale: Locale
): CalendarContext {
  const dateLocale = locale === "de" ? "de-DE" : "en-US";
  const now = new Date(currentIso);

  const todayParts = dateParts(now, timezone);
  const tomorrowParts = dateParts(addDays(now, 1), timezone);
  const yesterdayParts = dateParts(addDays(now, -1), timezone);

  // ISO weekday: Monday=1 … Sunday=7
  const isoDow = isoWeekday(now, timezone);
  const thisMonday = addDays(now, -(isoDow - 1));
  const thisSunday = addDays(thisMonday, 6);
  const nextMonday = addDays(thisMonday, 7);
  const nextSunday = addDays(nextMonday, 6);

  return {
    today: `${weekdayName(now, timezone, dateLocale)}, ${todayParts.ymd}`,
    tomorrow: `${weekdayName(addDays(now, 1), timezone, dateLocale)}, ${tomorrowParts.ymd}`,
    yesterday: `${weekdayName(addDays(now, -1), timezone, dateLocale)}, ${yesterdayParts.ymd}`,
    thisWeek: `${weekdayName(thisMonday, timezone, dateLocale)} ${ymd(thisMonday, timezone)} — ${weekdayName(
      thisSunday,
      timezone,
      dateLocale
    )} ${ymd(thisSunday, timezone)}`,
    nextWeek: `${weekdayName(nextMonday, timezone, dateLocale)} ${ymd(nextMonday, timezone)} — ${weekdayName(
      nextSunday,
      timezone,
      dateLocale
    )} ${ymd(nextSunday, timezone)}`,
    todayDayName: weekdayName(now, timezone, dateLocale)
  };
}

// ---- date helpers ----

function addDays(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function dateParts(d: Date, tz: string): { ymd: string } {
  return { ymd: ymd(d, tz) };
}

function ymd(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(d);
}

function weekdayName(d: Date, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "long"
  }).format(d);
}

function isoWeekday(d: Date, tz: string): number {
  // 1=Monday … 7=Sunday
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short"
  });
  const map: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7
  };
  const wk = fmt.format(d);
  return map[wk] ?? 1;
}
