"use client";

import { useTranslations } from "next-intl";
import { clsx } from "clsx";
import type { SessionState } from "@vtm/shared";

/**
 * The big orb the user taps to start. Visual states map 1:1 to SessionState:
 *   IDLE       → static gradient, breathing
 *   LISTENING  → blue pulsing
 *   THINKING   → orange/blue spinning conic
 *   EXECUTING  → green-blue spinning conic
 *   SPEAKING   → green breathing
 *   AWAITING   → amber pulsing
 *
 * Click handling:
 *   - if IDLE → start mic
 *   - if SPEAKING/THINKING → interrupt
 *   - if LISTENING → stop mic (optional; mostly we let VAD handle it)
 */

interface VoiceOrbProps {
  state: SessionState;
  micActive: boolean;
  onTap: () => void;
}

export function VoiceOrb({ state, micActive, onTap }: VoiceOrbProps) {
  const t = useTranslations("status");
  const tMic = useTranslations("mic");

  const orbClass = clsx(
    "relative h-44 w-44 rounded-full shadow-2xl transition-transform duration-300",
    {
      "orb-gradient animate-breathe": state === "IDLE",
      "orb-listening animate-breathe": state === "LISTENING",
      "orb-thinking": state === "THINKING" || state === "EXECUTING_TOOL",
      "orb-speaking animate-breathe": state === "SPEAKING",
      "bg-amber-500 animate-pulse": state === "AWAITING_CONFIRM"
    }
  );

  const label = (() => {
    if (state === "IDLE") return micActive ? t("idle") : tMic("tapToTalk");
    if (state === "LISTENING") return t("listening");
    if (state === "THINKING") return t("thinking");
    if (state === "EXECUTING_TOOL") return t("executing");
    if (state === "SPEAKING") return t("speaking");
    if (state === "AWAITING_CONFIRM") return t("awaiting_confirm");
    return t("idle");
  })();

  return (
    <div className="flex flex-col items-center gap-6 select-none">
      <button
        type="button"
        onClick={onTap}
        className={orbClass}
        aria-label={label}
      >
        <span className="sr-only">{label}</span>
        {/* Mic glyph */}
        <svg
          className="absolute inset-0 m-auto h-16 w-16 text-white/90 drop-shadow"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"
          />
        </svg>
      </button>
      <div className="text-center">
        <p className="text-lg font-medium tracking-tight">{label}</p>
      </div>
    </div>
  );
}
