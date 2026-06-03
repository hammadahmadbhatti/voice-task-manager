# Voice Task Manager 

This document explains how the **Voice Task Manager** satisfies each capability in
the assessment brief, with pointers to the exact code that implements it.

It is a monorepo (pnpm workspaces) with three packages:

| Package | Path | Role |
| --- | --- | --- |
| `@vtm/web` | `apps/web` | Next.js front end — mic capture, VAD, audio playback, transcript UI |
| `@vtm/realtime` | `apps/realtime` | Node/Express + Socket.IO orchestrator — STT, LLM, tools, TTS, auth, DB |
| `@vtm/shared` | `packages/shared` | Types, the WebSocket protocol, the system prompt, and the LLM tool schemas shared by both sides |

The design is a **hybrid**: AWS for the commodity pieces (Cognito auth, Polly
fallback TTS, RDS Postgres) and specialized vendors for the latency-critical
voice path (Deepgram STT, ElevenLabs TTS, OpenAI LLM).

---

## 1. The end-to-end voice loop

Everything runs over a single Socket.IO connection with two channels: a typed
JSON `msg` channel for control, and a binary `audio` channel for PCM (in) and
MP3 (out). The full contract lives in
[`protocol.ts`](packages/shared/src/protocol.ts).

```
 Browser (apps/web)                         Realtime server (apps/realtime)
 ─────────────────────                      ───────────────────────────────
 mic → PCM 16 kHz ──audio frames──────────▶ Deepgram live STT
 VAD endpoint  ──"stop_listening"─────────▶ finalize utterance
                  ◀──stt_partial / final──  transcript + confidence
                                            │
                                            ▼  runTurn()
                                            OpenAI (streaming, tool-calling)
                  ◀──assistant_text deltas─ stream tokens to transcript
                                            │  ↳ execute task tools (CRUD)
                  ◀──task_event──────────── task list mutated
                                            │
                                            ▼  speak()
                  ◀──tts_start────────────  ElevenLabs → Polly → browser
                  ◀──audio (MP3 chunks)───  streamed TTS
                  ◀──tts_end──────────────
 speaker ◀ MediaSource playback
```

The state machine the user sees as the animated orb is broadcast on the `state`
message: `IDLE → LISTENING → THINKING → EXECUTING_TOOL → SPEAKING → IDLE`
(see `SessionState` and the `state` emits in
[`conversation-agent.ts`](apps/realtime/src/orchestrator/conversation-agent.ts)).

---

## 2. Speech-to-Text (STT) — "Listen to the user"

**Provider:** Deepgram `nova-2-general`, streaming, via
[`stt-deepgram.ts`](apps/realtime/src/providers/stt-deepgram.ts).

- The browser captures mic audio as **PCM linear16, 16 kHz, mono**
  ([`recorder.ts`](apps/web/src/lib/audio/recorder.ts)) and streams raw frames
  over the binary `audio` channel.
- On the server, each frame is forwarded straight into the Deepgram live socket
  (`server.ts:170` → `conn.stt.send(buf)`).
- Deepgram is opened with `interim_results`, `smart_format`, `punctuate`, and
  `vad_events`, plus a `utterance_end_ms: 1200` safety net for endpointing
  (`stt-deepgram.ts:46`).
- Two callbacks surface results back to the client:
  `onPartial` → `stt_partial` (live, revisable) and `onFinal` → `stt_final`
  (locked-in). Each carries a **confidence** score (`server.ts:232`).
- A keep-alive ping every 8 s stops idle networks from dropping the socket
  (`stt-deepgram.ts:64`).

---

## 3. Text-to-Speech (TTS) — "Respond back using voice"

**Provider chain with automatic fallback:** ElevenLabs → AWS Polly → browser
`SpeechSynthesis`, in [`tts-chain.ts`](apps/realtime/src/providers/tts-chain.ts).

- Primary is **ElevenLabs Flash v2.5** (~75 ms time-to-first-byte), streamed as
  MP3 over HTTP and re-emitted chunk-by-chunk to the client
  ([`tts-elevenlabs.ts`](apps/realtime/src/providers/tts-elevenlabs.ts)).
- The chain uses a `primedStream` trick (`tts-chain.ts:57`): it awaits the
  **first chunk** before committing to a provider. If ElevenLabs throws (401,
  429, empty body), it fails over to Polly *before any audio has reached the
  client*. Once bytes are flowing we don't retry mid-stream.
- If both server providers fail, the chain returns `provider: "browser"` and the
  client speaks the text itself with the Web Speech API
  (`player.ts:151` `speakWithBrowserSynthesis`). The text to speak rides along on
  the `tts_start` message because the streamed transcript buffer has already been
  flushed (`conversation-agent.ts:428`).
- Playback on the client uses **MediaSource Extensions** so audio starts as soon
  as the first chunk arrives, not after the full clip downloads
  ([`player.ts`](apps/web/src/lib/audio/player.ts)).

---

## 4. Real-time voice interaction & natural conversation

- **Transport:** Socket.IO over WebSocket, chosen for built-in reconnection with
  exponential backoff and first-class binary frames (`server.ts:22`).
- **Streaming everywhere:** STT partials, LLM tokens, and TTS chunks all stream,
  so the user sees/hears responses forming instead of waiting for a full
  round-trip.
- **Turn-taking is VAD-driven.** A Silero VAD runs continuously in the browser
  ([`vad.ts`](apps/web/src/lib/audio/vad.ts)). `onSpeechEnd` finalizes the
  utterance (`stop_listening`) and re-opens the mic for the next one; `onSpeechStart`
  during playback triggers **barge-in** (see §8).
- **Heartbeat / latency:** an application-level `ping`/`pong` every 10 s measures
  round-trip latency for the UI (`ws-client.ts:69`).

---

## 5. Voice-based CRUD operations

The LLM never touches the database directly — it calls **typed tools**, and the
server executes them. The tool surface is defined once in zod and exposed to
OpenAI as function specs in
[`schemas/tools.ts`](packages/shared/src/schemas/tools.ts):

| Tool | CRUD | Handler |
| --- | --- | --- |
| `create_task` | **C** | `handleCreateTask` |
| `find_tasks` | **R** | `handleFindTasks` |
| `update_task` | **U** | `handleUpdateTask` |
| `delete_task` | **D** | `handleDeleteTask` |
| `request_clarification` | — | `handleRequestClarification` |

All handlers live in [`task-tools.ts`](apps/realtime/src/agents/task-tools.ts).
Each one:

1. **zod-validates** the model's arguments (defense in depth — the model can
   still emit bad JSON despite the schema), `task-tools.ts:61`.
2. Runs the side effect against Postgres
   ([`tasks-repo.ts`](apps/realtime/src/db/tasks-repo.ts)).
3. Updates session working memory (which tasks were referenced).
4. Returns a compact result, and emits a `task_event` so the UI list refreshes
   immediately (`conversation-agent.ts:149`).

`find_tasks` also does coarse **time-of-day** filtering (morning/afternoon/…
computed in the user's timezone) and **fuzzy title matching** with a
Sørensen–Dice bigram score, so "the LinkedIn post" matches "Post on LinkedIn"
(`task-tools.ts:115`, `task-tools.ts:351`).

---

## 6. Conversational AI workflows & context-aware responses

The "brain" is the agent loop in
[`conversation-agent.ts`](apps/realtime/src/orchestrator/conversation-agent.ts):
one user utterance drives an **iterate-until-resolved** loop (max 4 iterations to
bound cost). Each iteration is one streaming OpenAI call; the loop exits with
spoken text, or when a tool takes over the spoken response.

This cleanly handles multi-step workflows like *"find the LinkedIn task, then
move it to 7 PM"* — the model calls `find_tasks`, gets the result fed back, then
calls `update_task` on the resolved `taskId`.

**Context awareness** comes from three sources, all injected into the system
prompt every turn ([`prompts/system.ts`](packages/shared/src/prompts/system.ts)):

- **Working memory** — the `Session` tracks recently-referenced tasks in order
  ([`session.ts`](apps/realtime/src/orchestrator/session.ts)). This is how
  *"the previous one"*, *"the second one"*, *"it"* resolve to a concrete task ID.
- **Pre-resolved calendar** — `TODAY / TOMORROW / THIS_WEEK / NEXT_WEEK` are
  computed with weekday names so the model never does date math on a raw
  timestamp (`system.ts:165`). This is what makes *"tomorrow evening"* and *"this
  week"* reliable.
- **Pending-confirmation state** — so a bare *"yes"* is interpreted as confirming
  a delete rather than starting something new (`system.ts:132`).

The response style is constrained for voice: short, no markdown, no bullet lists,
past-tense confirmations — because every reply is read aloud (`system.ts:50`).

---

## 7. Database & session handling

### Database (PostgreSQL)
Storage is **PostgreSQL** via Drizzle ORM + `pg`
([`schema.ts`](apps/realtime/src/db/schema.ts)). Local dev uses the Postgres
container in `docker-compose.yml`; production points `DATABASE_URL` at RDS with
`sslmode=require`. Two tables:

- `users` — one row per identity, keyed on `external_id`
  (`cognito:<sub>` or `anon:<uuid>`). A separate internal UUID PK means an
  anonymous user can later be promoted to a Cognito user without re-pointing
  task FKs.
- `tasks` — FK to `users.id` with `ON DELETE CASCADE`, indexed on
  `(user_id, scheduled_at)` and `(user_id, status, scheduled_at)` for the common
  "this user's tasks in a window" query.

### Signup / Login
**AWS Cognito** issues ID tokens; the server verifies them against the pool's
JWKS in [`auth.ts`](apps/realtime/src/middleware/auth.ts). Client-side OAuth
helpers are in [`cognito.ts`](apps/web/src/lib/cognito.ts), with the redirect
handled at `apps/web/src/app/[locale]/auth/callback/page.tsx`.

An **anonymous mode** (`ALLOW_ANONYMOUS=true`) lets users try the app with no
signup: the browser stores a stable UUID in localStorage
([`anon-id.ts`](apps/web/src/lib/anon-id.ts)) and the server maps it to
`external_id = "anon:<uuid>"`. The same identity is used by **both** the
WebSocket session and the REST `/api/tasks` endpoint, so the spoken view and the
list view always agree (`server.ts:66`, `useVoiceSession.ts:97`).

### Session handling
Each WebSocket connection gets an in-memory `Session`
([`session.ts`](apps/realtime/src/orchestrator/session.ts)) holding the sliding
conversation history (last ~30 turns), referenced-task memory, pending
confirmation, and the current `AbortController`. It's intentionally in-memory —
the connection is sticky to one Node process and the data doesn't outlive a
disconnect; the comment notes moving to Redis is a small change if we go
multi-instance.

---

## 8. Interruption handling — "No, delete the LinkedIn one."

This is the headline scenario. Expected behavior: **stop playback immediately**,
and **continue the conversation naturally**. Here is exactly how it works.

**Client side** ([`useVoiceSession.ts`](apps/web/src/hooks/useVoiceSession.ts)):
the VAD never stops listening, even while the assistant is speaking. When it
detects speech during `SPEAKING`/`THINKING` (`useVoiceSession.ts:268`):

1. `playerRef.current.stop()` — tears down the MediaSource and revokes the object
   URL **synchronously**, so audio halts in well under 50 ms
   (`player.ts:80`). A generation counter discards any TTS chunks still
   in flight from the interrupted turn (`player.ts:66`).
2. `browserTtsRef.current?.cancel()` — cancels Web Speech fallback if that path
   was active.
3. Sends `interrupt` to the server.

**Server side** (`server.ts:304` `handleInterrupt`): calls
`session.abortInflight()`, which aborts the current `AbortController`. That
single signal is threaded through the LLM stream (`llm-openai.ts:78`) and the TTS
stream (`conversation-agent.ts:438`), so both stop producing immediately. The
server emits `state: IDLE`.

**Continuing naturally:** the user's interrupting words were *also* being
transcribed by Deepgram the whole time, so "No, delete the LinkedIn one" comes
back as a normal `stt_final`. That kicks off a fresh `runTurn` with a new abort
controller (`server.ts:263`). The model:

- reads **working memory** to resolve "the LinkedIn one" to a task ID,
- calls `delete_task` with `confirmed=false`, which **stages a confirmation** and
  speaks *"Are you sure you want to delete the … task? Please say yes or no."*
  (`task-tools.ts:218`).

So the barge-in doesn't just stop the audio — it flows straight into the next
intent without losing context.

---

## 9. Error handling & robustness

| Failure | How it's handled | Where |
| --- | --- | --- |
| **Unclear command / garbled speech** | If `stt_final` confidence `< 0.55`, the server skips the LLM entirely and speaks *"Sorry, I didn't quite catch that. Could you say it again?"* (localized) | `server.ts:243` |
| **Ambiguous reference** | Model calls `request_clarification` with candidate tasks instead of guessing; server speaks the question directly | `task-tools.ts:252`, `system.ts:62` |
| **STT failure** | Deepgram `onError` → `error` message (`code: stt_failed`, `retryable: true`) shown in UI | `server.ts:281` |
| **TTS failure** | Provider fallback chain ElevenLabs → Polly → browser SpeechSynthesis; the user still hears a reply even if both cloud providers are down | `tts-chain.ts:24` |
| **LLM timeout** | `streamCompletion` enforces a 12 s deadline; on timeout/error it emits `llm_failed` and bails the turn instead of hanging | `llm-openai.ts:55`, `conversation-agent.ts:102` |
| **LLM tool loop runaway** | Hard cap of `MAX_TOOL_ITERATIONS = 4`; if exceeded it speaks a graceful apology | `conversation-agent.ts:40`, `:196` |
| **WebSocket disconnect** | Socket.IO auto-reconnects with backoff (infinite attempts, 0.5–8 s); on reconnect the client re-sends `hello` to rebuild the session; server tears down STT and aborts in-flight work on disconnect | `ws-client.ts:29`, `useVoiceSession.ts:127`, `server.ts:176` |
| **Malformed model output** | Every tool re-validates args with zod and returns a structured error the model can recover from on the next iteration | `task-tools.ts:61`, `:298` |
| **Bad env config** | Server fails fast at boot if required env vars are missing (zod-validated) | `config.ts:45` |
| **Graceful shutdown** | SIGINT/SIGTERM closes Socket.IO, drains the DB pool, and hard-exits after 5 s if anything hangs | `server.ts:326` |

---

## 10. Safety: validating & confirming destructive actions

Deletes are gated by a **two-layer confirmation** so a misfire can't destroy
data:

1. **Prompt layer** — the system prompt instructs the model to call `delete_task`
   with `confirmed=false` the first time, and `confirmed=true` only after an
   explicit "yes" in the *immediately preceding* turn (`system.ts:61`).
2. **Server layer (defense in depth)** — even if the model wrongly sets
   `confirmed=true`, the handler independently checks the session's `pending`
   state. Unless a matching pending-delete confirmation exists, it refuses and
   re-stages the prompt instead of deleting (`task-tools.ts:213`).

Pending confirmations **expire after 30 s** (`session.ts:20`,
`expireStalePending`), so a stale "yes" much later can't trigger an old delete.

The confirmation prompt is spoken **directly** via `speakDirectly`, bypassing the
LLM — it's fixed text, so there's no reason to spend a model call on it
(`task-tools.ts:229`). The same direct-speak path serves low-confidence
apologies and clarifications ([`speak-direct.ts`](apps/realtime/src/orchestrator/speak-direct.ts)).

---

## 11. Latency budget

Low response latency is engineered, not incidental:

- **Streaming at every hop** — STT partials, LLM tokens, and TTS chunks all
  stream; the user hears the first word of the reply long before the full
  sentence is generated.
- **Fast models** — Deepgram nova-2 (live), GPT-4o-mini (~400 ms TTFT),
  ElevenLabs Flash v2.5 (~75 ms TTFB).
- **Skip the LLM when possible** — confirmations, clarifications, and
  low-confidence apologies are spoken from fixed text via `speakDirect`, saving a
  full model round-trip.
- **MSE playback** — audio begins on the first chunk, not after full download.
- **Provider priming** — TTS failover happens before any audio is committed, so a
  dead provider doesn't add a visible stall.

---

## 12. Tests

Unit tests cover the trickiest invariants:

- `apps/realtime/src/__tests__/build-messages.test.ts` — the OpenAI
  message-reconstruction logic (orphaned-tool-call pruning after history trim).
- `apps/realtime/src/__tests__/task-tools.test.ts` — CRUD handlers and the delete
  confirmation gate.
- `apps/realtime/src/__tests__/session.test.ts` — working memory & pending TTL.
- `packages/shared/src/__tests__/system-prompt.test.ts` and `tools.test.ts` —
  calendar resolution and tool-schema correctness.

Run them with `pnpm -r test`.

---

### Requirement → implementation cheat sheet

| Assessment item | Primary location |
| --- | --- |
| Listen to the user (STT) | `providers/stt-deepgram.ts`, `lib/audio/recorder.ts` |
| Respond with voice (TTS) | `providers/tts-chain.ts`, `lib/audio/player.ts` |
| Real-time conversation | `server.ts`, `lib/ws-client.ts`, `hooks/useVoiceSession.ts` |
| Voice CRUD | `agents/task-tools.ts`, `schemas/tools.ts` |
| Conversational / context-aware | `orchestrator/conversation-agent.ts`, `prompts/system.ts`, `orchestrator/session.ts` |
| Database | `db/schema.ts`, `db/tasks-repo.ts` |
| Signup / Login / Session | `middleware/auth.ts`, `lib/cognito.ts`, `orchestrator/session.ts` |
| Interruption / barge-in | `hooks/useVoiceSession.ts`, `lib/audio/player.ts`, `server.ts` (`handleInterrupt`) |
| Unclear commands | `server.ts` (confidence gate), `request_clarification` |
| STT / TTS / LLM / WS failures | `server.ts`, `tts-chain.ts`, `llm-openai.ts`, `ws-client.ts` |
| Validate / confirm destructive | `agents/task-tools.ts` (`handleDeleteTask`), `prompts/system.ts` |
| Low latency | streaming pipeline + `speak-direct.ts` |
