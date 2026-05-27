"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import type { Task } from "@vtm/shared";

interface TaskListProps {
  tasks: Task[];
  timezone: string;
  locale: "en" | "de";
}

/**
 * Passive task list — purely display, no edit/delete buttons.
 * That's the whole point of the project: all CRUD via voice.
 *
 * Groups tasks into Today / Tomorrow / Later in the user's timezone.
 */
export function TaskList({ tasks, timezone, locale }: TaskListProps) {
  const t = useTranslations("tasks");

  const groups = useMemo(() => {
    const now = new Date();
    const todayKey = ymdInTz(now, timezone);
    const tomorrowKey = ymdInTz(new Date(now.getTime() + 24 * 3600_000), timezone);
    const today: Task[] = [];
    const tomorrow: Task[] = [];
    const later: Task[] = [];
    const sorted = [...tasks].sort((a, b) =>
      a.scheduledAt.localeCompare(b.scheduledAt)
    );
    for (const task of sorted) {
      const k = ymdInTz(new Date(task.scheduledAt), timezone);
      if (k === todayKey) today.push(task);
      else if (k === tomorrowKey) tomorrow.push(task);
      else later.push(task);
    }
    return { today, tomorrow, later };
  }, [tasks, timezone]);

  if (tasks.length === 0) {
    return <p className="text-muted text-sm italic">{t("empty")}</p>;
  }

  return (
    <div className="space-y-6">
      <Group title={t("title")} tasks={groups.today} timezone={timezone} locale={locale} />
      <Group title={t("tomorrow")} tasks={groups.tomorrow} timezone={timezone} locale={locale} />
      <Group title={t("later")} tasks={groups.later} timezone={timezone} locale={locale} />
    </div>
  );
}

function Group({
  title,
  tasks,
  timezone,
  locale
}: {
  title: string;
  tasks: Task[];
  timezone: string;
  locale: "en" | "de";
}) {
  if (tasks.length === 0) return null;
  return (
    <section>
      <h3 className="text-xs uppercase tracking-wider text-muted mb-2">{title}</h3>
      <ul className="space-y-2">
        {tasks.map((task) => (
          <li
            key={task.id}
            className="flex items-baseline gap-3 rounded-xl bg-white/70 backdrop-blur border border-black/5 px-3 py-2"
          >
            <span className="font-mono text-sm tabular-nums w-16 text-accent">
              {formatTime(task.scheduledAt, timezone, locale)}
            </span>
            <span className="text-sm flex-1">{task.title}</span>
            {task.status === "done" && (
              <span className="text-xs text-muted">✓</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ymdInTz(d: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(d);
}

function formatTime(iso: string, tz: string, locale: "en" | "de"): string {
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: locale === "en"
  }).format(new Date(iso));
}
