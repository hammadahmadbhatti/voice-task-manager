"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerMessage, SessionState, Task } from "@vtm/shared";
import { MicRecorder } from "@/lib/audio/recorder";
import { VADController } from "@/lib/audio/vad";
import { StreamPlayer, speakWithBrowserSynthesis } from "@/lib/audio/player";
import { VtmSocket } from "@/lib/ws-client";
import { getOrCreateAnonId } from "@/lib/anon-id";
import type { Locale } from "@/i18n/config";

/**
 * The client-side conductor. Owns:
 *   - MicRecorder (PCM frames)
 *   - VAD (speech detection + barge-in)
 *   - WebSocket (control + audio)
 *   - StreamPlayer (TTS playback)
 *
 * State surface:
 *   - state, hint:       which orb animation to show
 *   - userTranscript:    live STT text (partial + final)
 *   - assistantText:     streamed text of current assistant response
 *   - turns:             completed dialog history (for transcript view)
 *   - tasks:             latest pulled task list
 *   - connected:         WS up?
 *   - latencyMs:         heartbeat round-trip
 *   - error:             last error (cleared on next user action)
 *
 * Lifecycle:
 *   const session = useVoiceSession({ ... });
 *   await session.connect();   // gestures-required: call from user click
 *   session.startMic();
 *   ...
 *   session.stop();            // cleanup
 */

export interface UseVoiceSessionOptions {
  wsUrl: string;
  apiUrl: string;
  authToken: string | null;
  locale: Locale;
  timezone: string;
}

export interface CompletedTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}

export interface VoiceSession {
  state: SessionState;
  hint: string | null;
  userTranscript: string;
  userFinalConfidence: number | null;
  assistantText: string;
  turns: CompletedTurn[];
  tasks: Task[];
  connected: boolean;
  latencyMs: number | null;
  error: string | null;
  ttsProvider: "elevenlabs" | "polly" | "browser" | null;
  connect: () => Promise<void>;
  startMic: () => Promise<void>;
  stopMic: () => void;
  interrupt: () => void;
  refreshTasks: () => Promise<void>;
  disconnect: () => void;
}

export function useVoiceSession(opts: UseVoiceSessionOptions): VoiceSession {
  const socketRef = useRef<VtmSocket | null>(null);
  const recRef = useRef<MicRecorder | null>(null);
  const vadRef = useRef<VADController | null>(null);
  const playerRef = useRef<StreamPlayer | null>(null);
  const currentGenRef = useRef(0);
  const browserTtsRef = useRef<{ cancel: () => void } | null>(null);
  const pendingAssistantTextRef = useRef("");

  const [state, setState] = useState<SessionState>("IDLE");
  const [hint, setHint] = useState<string | null>(null);
  const [userTranscript, setUserTranscript] = useState("");
  const [userFinalConfidence, setUserFinalConfidence] = useState<number | null>(
    null
  );
  const [assistantText, setAssistantText] = useState("");
  const [turns, setTurns] = useState<CompletedTurn[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [connected, setConnected] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ttsProvider, setTtsProvider] = useState<
    "elevenlabs" | "polly" | "browser" | null
  >(null);

  const refreshTasks = useCallback(async () => {
    try {
      // Send EITHER the Cognito JWT OR the anonymous UUID — server upserts
      // a user row keyed on whichever identity it gets, and that row's id
      // is the same one the WebSocket session uses. So task lists match.
      const headers: Record<string, string> = {};
      if (opts.authToken) {
        headers.authorization = `Bearer ${opts.authToken}`;
      } else {
        const anon = getOrCreateAnonId();
        if (anon !== "ssr-placeholder") headers["x-anon-id"] = anon;
      }
      const res = await fetch(`${opts.apiUrl}/api/tasks`, { headers });
      if (!res.ok) return;
      const data = (await res.json()) as { tasks: Task[] };
      setTasks(data.tasks);
    } catch (err) {
      console.warn("refreshTasks failed", err);
    }
  }, [opts.apiUrl, opts.authToken]);

  // ---------- WebSocket connect ----------

  const connect = useCallback(async () => {
    if (socketRef.current) return;
    playerRef.current = new StreamPlayer();

    const socket = new VtmSocket({
      url: opts.wsUrl,
      authToken: opts.authToken,
      onConnectChange: (c) => {
        setConnected(c);
        if (c) {
          socket.send({
            type: "hello",
            idToken: opts.authToken,
            // Always send anonId — server ignores it when idToken is present,
            // but keeps anon WebSocket and REST identities aligned otherwise.
            anonId: opts.authToken ? null : getOrCreateAnonId(),
            locale: opts.locale,
            timezone: opts.timezone,
            clientNow: new Date().toISOString()
          });
        }
      },
      onLatency: (ms) => setLatencyMs(ms),
      onMessage: (msg) => handleServerMessage(msg),
      onAudio: (chunk) => {
        playerRef.current?.push(currentGenRef.current, new Uint8Array(chunk));
      }
    });
    socketRef.current = socket;
    await refreshTasks();
  }, [opts.wsUrl, opts.authToken, opts.locale, opts.timezone, refreshTasks]);

  // ---------- Server message dispatch ----------

  const handleServerMessage = useCallback(
    (msg: ServerMessage) => {
      switch (msg.type) {
        case "ready":
          // Session started. Nothing user-visible needed.
          break;
        case "state":
          setState(msg.state);
          setHint(msg.hint ?? null);
          if (msg.state === "LISTENING") {
            // Stop assistant audio if we're still playing
            playerRef.current?.stop();
            browserTtsRef.current?.cancel();
            setAssistantText("");
            pendingAssistantTextRef.current = "";
          }
          break;
        case "stt_partial":
          setUserTranscript(msg.text);
          break;
        case "stt_final":
          setUserTranscript(msg.text);
          setUserFinalConfidence(msg.confidence);
          // Push as a completed turn
          if (msg.text.trim()) {
            setTurns((t) => [
              ...t,
              {
                id: `u-${Date.now()}`,
                role: "user",
                text: msg.text,
                at: Date.now()
              }
            ]);
          }
          break;
        case "assistant_text":
          pendingAssistantTextRef.current += msg.delta;
          setAssistantText(pendingAssistantTextRef.current);
          if (msg.done) {
            const full = pendingAssistantTextRef.current.trim();
            if (full) {
              setTurns((t) => [
                ...t,
                {
                  id: `a-${Date.now()}`,
                  role: "assistant",
                  text: full,
                  at: Date.now()
                }
              ]);
            }
            pendingAssistantTextRef.current = "";
            setAssistantText("");
          }
          break;
        case "tts_end":
          playerRef.current?.end(currentGenRef.current);
          break;
        case "task_event":
          // Authoritative refetch — cheaper than reconciling deltas
          refreshTasks();
          break;
        case "error":
          setError(msg.message);
          break;
        case "pong":
          // Handled in VtmSocket via onLatency
          break;
        default: {
          // `tts_start` is sent by the server; widen the type here
          const m = msg as unknown as {
            type: string;
            format?: string;
            sampleRate?: number;
            provider?: "elevenlabs" | "polly" | "browser";
          };
          if (m.type === "tts_start") {
            const { generation } = playerRef.current!.start();
            currentGenRef.current = generation;
            if (m.provider) setTtsProvider(m.provider);
            // If server says provider=browser, speak the buffered text via SpeechSynthesis
            if (m.provider === "browser" && assistantText) {
              browserTtsRef.current = speakWithBrowserSynthesis(
                assistantText,
                opts.locale
              );
            }
          }
        }
      }
    },
    [refreshTasks, assistantText, opts.locale]
  );

  // ---------- Microphone + VAD ----------

  const startMic = useCallback(async () => {
    if (!socketRef.current) await connect();
    if (recRef.current?.isRunning()) return;

    setError(null);

    const rec = new MicRecorder();
    await rec.start((frame) => {
      socketRef.current?.sendAudio(frame);
    });
    recRef.current = rec;

    // Tell server to open a Deepgram stream
    socketRef.current!.send({ type: "start_listening" });

    // Start VAD for barge-in. The VAD runs continuously (even during TTS)
    // so we can interrupt the assistant.
    const vad = new VADController();
    await vad.start({
      onSpeechStart: () => {
        if (state === "SPEAKING" || state === "THINKING") {
          // Barge-in: kill audio + tell server to abort
          playerRef.current?.stop();
          browserTtsRef.current?.cancel();
          socketRef.current?.send({ type: "interrupt" });
        }
      },
      onSpeechEnd: () => {
        // Tell server to finalize STT; Deepgram + server side will emit stt_final
        socketRef.current?.send({ type: "stop_listening" });
        // Reopen for the next utterance
        setTimeout(() => {
          if (recRef.current?.isRunning()) {
            socketRef.current?.send({ type: "start_listening" });
          }
        }, 200);
      }
    });
    vadRef.current = vad;
  }, [connect, state]);

  const stopMic = useCallback(() => {
    socketRef.current?.send({ type: "stop_listening" });
    recRef.current?.stop();
    recRef.current = null;
    vadRef.current?.destroy();
    vadRef.current = null;
  }, []);

  const interrupt = useCallback(() => {
    playerRef.current?.stop();
    browserTtsRef.current?.cancel();
    socketRef.current?.send({ type: "interrupt" });
  }, []);

  const disconnect = useCallback(() => {
    stopMic();
    playerRef.current?.stop();
    socketRef.current?.close();
    socketRef.current = null;
  }, [stopMic]);

  useEffect(
    () => () => {
      disconnect();
    },
    [disconnect]
  );

  return {
    state,
    hint,
    userTranscript,
    userFinalConfidence,
    assistantText,
    turns,
    tasks,
    connected,
    latencyMs,
    error,
    ttsProvider,
    connect,
    startMic,
    stopMic,
    interrupt,
    refreshTasks,
    disconnect
  };
}
