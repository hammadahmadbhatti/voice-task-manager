"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useVoiceSession } from "@/hooks/useVoiceSession";
import { VoiceOrb } from "@/components/VoiceOrb";
import { Transcript } from "@/components/Transcript";
import { TaskList } from "@/components/TaskList";
import { LanguageToggle } from "@/components/LanguageToggle";
import {
  decodeIdToken,
  getStoredTokens,
  isCognitoConfigured,
  signOut,
  startSignIn
} from "@/lib/cognito";
import type { Locale } from "@/i18n/config";

export default function HomePage({
  params
}: {
  params: { locale: Locale };
}) {
  const t = useTranslations();
  const locale = params.locale;

  // Best effort timezone detection
  const timezone = useMemo(
    () =>
      typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone
        : "Europe/Berlin",
    []
  );

  const wsUrl =
    process.env.NEXT_PUBLIC_WS_URL ?? "http://localhost:4000";
  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL ?? wsUrl;
  const allowAnon = process.env.NEXT_PUBLIC_ALLOW_ANONYMOUS === "true";

  const [authToken, setAuthToken] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [micActive, setMicActive] = useState(false);

  useEffect(() => {
    const tokens = getStoredTokens();
    if (tokens) {
      setAuthToken(tokens.idToken);
      const claims = decodeIdToken(tokens.idToken);
      setUserName(claims?.name ?? claims?.given_name ?? claims?.email ?? null);
    }
    setAuthChecked(true);
  }, []);

  const session = useVoiceSession({
    wsUrl,
    apiUrl,
    authToken,
    locale,
    timezone
  });

  const onOrbTap = async () => {
    if (!session.connected) {
      await session.connect();
    }
    if (session.state === "SPEAKING" || session.state === "THINKING") {
      session.interrupt();
      return;
    }
    if (!micActive) {
      await session.startMic();
      setMicActive(true);
    } else {
      session.stopMic();
      setMicActive(false);
    }
  };

  if (!authChecked) return null;

  const cognitoOn = isCognitoConfigured();
  const requireAuth = cognitoOn && !allowAnon && !authToken;

  return (
    <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
      {/* Header */}
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("app.title")}
          </h1>
          <p className="text-sm text-muted">{t("app.tagline")}</p>
        </div>
        <div className="flex items-center gap-3">
          <LanguageToggle currentLocale={locale} />
          {authToken ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted truncate max-w-[160px]">
                {userName ?? "—"}
              </span>
              <button
                onClick={() => signOut()}
                className="text-xs px-3 py-1 rounded-full bg-white/70 border border-black/5"
              >
                {t("auth.signOut")}
              </button>
            </div>
          ) : cognitoOn ? (
            <>
              <button
                onClick={() => startSignIn("Google")}
                className="text-xs px-3 py-1 rounded-full bg-white/70 border border-black/5"
              >
                {t("auth.signInWithGoogle")}
              </button>
              <button
                onClick={() => startSignIn()}
                className="text-xs px-3 py-1 rounded-full bg-ink text-cream"
              >
                {t("auth.signIn")}
              </button>
            </>
          ) : null}
        </div>
      </header>

      {requireAuth ? (
        <SignInPrompt onSignIn={() => startSignIn()} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-[calc(100vh-180px)]">
          {/* Left: orb + status */}
          <section className="lg:col-span-4 flex flex-col items-center justify-center gap-8">
            <VoiceOrb
              state={session.state}
              micActive={micActive}
              onTap={onOrbTap}
            />
            <div className="text-xs text-muted flex flex-col items-center gap-1">
              <span>
                {session.connected ? "● connected" : "○ disconnected"}{" "}
                {session.latencyMs !== null && `· ${session.latencyMs}ms`}
              </span>
              {session.ttsProvider && (
                <span>tts: {session.ttsProvider}</span>
              )}
              {session.error && (
                <span className="text-red-600">{session.error}</span>
              )}
            </div>
          </section>

          {/* Middle: transcript */}
          <section className="lg:col-span-5 min-h-[300px]">
            <Transcript
              turns={session.turns}
              liveAssistant={session.assistantText}
              liveUser={session.userTranscript}
            />
          </section>

          {/* Right: task list */}
          <aside className="lg:col-span-3 overflow-y-auto">
            <TaskList
              tasks={session.tasks}
              timezone={timezone}
              locale={locale}
            />
          </aside>
        </div>
      )}
    </main>
  );
}

function SignInPrompt({ onSignIn }: { onSignIn: () => void }) {
  const t = useTranslations();
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
      <h2 className="text-3xl font-semibold max-w-xl text-center">
        {t("app.tagline_long")}
      </h2>
      <button
        onClick={onSignIn}
        className="px-6 py-3 rounded-full bg-ink text-cream text-sm font-medium"
      >
        {t("auth.signIn")}
      </button>
    </div>
  );
}
