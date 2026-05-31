/**
 * WebSocket message protocol between the browser and the realtime
 * orchestrator. Both sides import these types so the contract stays
 * honest at compile time.
 *
 * Wire format: JSON for control messages, raw binary frames for audio.
 *
 * --- Lifecycle ----------------------------------------------------------
 *   client → server   hello                (auth token, locale, tz)
 *   server → client   ready                (session_id)
 *   client → server   start_listening      (begin streaming PCM)
 *   client → server   <binary PCM frames>  (16 kHz, 16-bit, mono)
 *   client → server   stop_listening       (VAD endpointed)
 *   server → client   stt_partial          (interim transcript)
 *   server → client   stt_final            (final transcript)
 *   server → client   state                (state machine transition)
 *   server → client   assistant_text       (token-by-token, for transcript)
 *   server → client   <binary TTS frames>  (MP3 or PCM)
 *   server → client   tts_end              (final audio chunk delivered)
 *   server → client   task_event           (task list mutation hint)
 *   server → client   error                (recoverable failure)
 *   client → server   interrupt            (barge-in detected)
 *   client → server   ping / server → pong (heartbeat)
 * ------------------------------------------------------------------------
 */

import type { Locale, SessionState, Task } from "./types.js";

// ---------- Client → Server ----------

export interface ClientHello {
  type: "hello";
  /** Cognito ID token; server verifies signature against JWKS */
  idToken: string | null; // null = anonymous session
  /**
   * Stable client-generated UUID for anonymous identity. Lives in
   * localStorage so reloading the tab resumes the same anonymous user.
   * Ignored when idToken is present.
   */
  anonId: string | null;
  locale: Locale;
  /** IANA tz, e.g. "Europe/Berlin" */
  timezone: string;
  /** ISO 8601 of the client's wall-clock at handshake, for clock-skew detection */
  clientNow: string;
}

export interface ClientStartListening {
  type: "start_listening";
}

export interface ClientStopListening {
  type: "stop_listening";
}

export interface ClientInterrupt {
  type: "interrupt";
  /** Optional: client's best-guess transcript so far, lets server pre-empt */
  partial?: string;
}

export interface ClientPing {
  type: "ping";
  t: number;
}

export type ClientMessage =
  | ClientHello
  | ClientStartListening
  | ClientStopListening
  | ClientInterrupt
  | ClientPing;

// ---------- Server → Client ----------

export interface ServerReady {
  type: "ready";
  sessionId: string;
  /**
   * Internal users.id (UUID) assigned to this session. Useful for client
   * debugging — also lets the UI display "logged in as <name>" without
   * a separate API roundtrip.
   */
  userId: string;
  /** True if the session is unauthenticated. */
  anonymous: boolean;
  /** Server's wall-clock for clock-skew detection */
  serverNow: string;
}

export interface ServerSttPartial {
  type: "stt_partial";
  text: string;
  /** Deepgram confidence 0..1 */
  confidence: number;
}

export interface ServerSttFinal {
  type: "stt_final";
  text: string;
  confidence: number;
}

export interface ServerState {
  type: "state";
  state: SessionState;
  /** Free-form sub-state hint for the UI orb (e.g. "thinking", "calling_tool:create_task") */
  hint?: string;
}

export interface ServerAssistantText {
  type: "assistant_text";
  /** Streamed deltas. Concatenate on the client to render the transcript. */
  delta: string;
  /** True for the final delta of a turn */
  done: boolean;
}

export interface ServerTtsEnd {
  type: "tts_end";
  /** Total audio bytes streamed, for client telemetry */
  bytes: number;
}

/**
 * Hint that the task list mutated. The client refetches authoritative
 * state from the REST API rather than trusting this payload as the
 * source of truth — but the optional `task` lets us update optimistically.
 */
export interface ServerTaskEvent {
  type: "task_event";
  action: "created" | "updated" | "deleted";
  taskId: string;
  task?: Task; // present for created/updated
}

export interface ServerError {
  type: "error";
  /** Stable error code, suitable for client-side localization */
  code:
    | "stt_failed"
    | "llm_failed"
    | "llm_timeout"
    | "tts_failed"
    | "tool_failed"
    | "auth_failed"
    | "rate_limited"
    | "internal";
  /** Human-readable English message — UI may show or use the code for i18n */
  message: string;
  /** True if the user should retry, false if the system already retried */
  retryable: boolean;
}

export interface ServerPong {
  type: "pong";
  t: number;
}

// ---------- Audio frame contract ----------

/**
 * Audio frames from client are sent as raw ArrayBuffer over WS:
 *   Format:      PCM linear16, little-endian, mono
 *   Sample rate: 16000 Hz
 *   Frame size:  20–40 ms recommended (320–640 samples = 640–1280 bytes)
 *
 * Audio frames from server are sent as MP3 chunks from ElevenLabs / Polly.
 * The first frame is preceded by a `tts_start` sentinel describing the
 * format the client should decode and which provider produced it.
 */
export type TtsProvider = "elevenlabs" | "polly" | "browser";

export interface ServerTtsStart {
  type: "tts_start";
  format: "mp3" | "pcm16";
  sampleRate: number;
  /**
   * Which server-side provider produced the audio that follows.
   *   - "elevenlabs" / "polly": stream MP3 chunks via the audio channel
   *   - "browser": the server has no audio for this turn; the client
   *     should speak `text` itself via SpeechSynthesis. No audio chunks
   *     will arrive before `tts_end`.
   */
  provider: TtsProvider;
  /**
   * Present when `provider === "browser"`: the text the client must read
   * aloud. It's included here because `assistant_text done=true` already
   * cleared the streamed buffer on the client by the time `tts_start`
   * arrives.
   */
  text?: string;
}

export type ServerMessage =
  | ServerReady
  | ServerSttPartial
  | ServerSttFinal
  | ServerState
  | ServerAssistantText
  | ServerTtsStart
  | ServerTtsEnd
  | ServerTaskEvent
  | ServerError
  | ServerPong;
