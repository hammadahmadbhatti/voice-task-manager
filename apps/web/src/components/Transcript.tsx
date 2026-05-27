"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { clsx } from "clsx";
import type { CompletedTurn } from "@/hooks/useVoiceSession";

interface TranscriptProps {
  turns: CompletedTurn[];
  /** Streamed in-progress text from assistant */
  liveAssistant: string;
  /** STT partial from user while they're talking */
  liveUser: string;
}

export function Transcript({ turns, liveAssistant, liveUser }: TranscriptProps) {
  const t = useTranslations("transcript");
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Always pin scroll to bottom on new content.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [turns.length, liveAssistant, liveUser]);

  const empty = turns.length === 0 && !liveAssistant && !liveUser;

  return (
    <div
      ref={scrollerRef}
      className="h-full overflow-y-auto rounded-2xl bg-white/60 backdrop-blur p-4 border border-black/5"
    >
      {empty && (
        <div className="text-muted text-sm italic">{t("empty")}</div>
      )}
      <ul className="space-y-3">
        {turns.map((turn) => (
          <li
            key={turn.id}
            className={clsx("flex flex-col", {
              "items-end": turn.role === "user",
              "items-start": turn.role === "assistant"
            })}
          >
            <span className="text-[10px] uppercase tracking-wider text-muted">
              {turn.role === "user" ? t("you") : t("assistant")}
            </span>
            <p
              className={clsx(
                "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed mt-1",
                turn.role === "user"
                  ? "bg-ink text-cream"
                  : "bg-accent/10 text-ink"
              )}
            >
              {turn.text}
            </p>
          </li>
        ))}
        {liveUser && (
          <li className="flex flex-col items-end">
            <span className="text-[10px] uppercase tracking-wider text-muted">
              {t("you")}
            </span>
            <p className="max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed mt-1 bg-ink/70 text-cream italic">
              {liveUser}
            </p>
          </li>
        )}
        {liveAssistant && (
          <li className="flex flex-col items-start">
            <span className="text-[10px] uppercase tracking-wider text-muted">
              {t("assistant")}
            </span>
            <p className="max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed mt-1 bg-accent/10 text-ink">
              {liveAssistant}
              <span className="inline-block w-2 h-3 ml-1 bg-accent animate-pulse align-middle" />
            </p>
          </li>
        )}
      </ul>
    </div>
  );
}
