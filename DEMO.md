# Demo Script

A 5–7 minute walkthrough that exercises every requirement from the Urban Ground brief. Designed to be recorded as a Loom or screen-capture without retakes.

> **Tip:** Keep the browser console (F12) open during the recording. Some scenarios are more obvious when the reviewer can see the WebSocket frames or state transitions.

## Setup before pressing record

1. Frontend on `http://localhost:3000/en` (or your Vercel URL)
2. Open Chrome or Safari — Firefox's AudioWorklet sometimes glitches on first capture
3. Pre-allow microphone access on the site (settings → permissions)
4. Clear DynamoDB if you've been testing — `docker compose down && docker compose up -d && pnpm --filter @vtm/realtime exec tsx scripts/create-local-table.ts`
5. Have the task list visible on the right side of the screen — viewers should see entries appear/disappear as you speak

The **tts:** label under the orb shows the active TTS provider. If it ever flips from `elevenlabs` to `polly` or `browser` during the demo, that's a working fallback chain — call it out, don't hide it.

---

## Section 1 — Create (1 min)

### Scenario 1: Single creation

🎤 *"Create a task for syncing with the product manager at 10 AM."*

**Expected:**
- Orb cycles BLUE (listening) → ORANGE/BLUE conic (thinking) → GREEN (speaking)
- Task appears on the right panel with `10:00 AM · Sync with product manager`
- Assistant says something like: *"Done — synced you with the product manager at 10 AM."*
- Latency from end-of-speech to assistant's first audible word: **800–1200 ms**

**Point out on camera:** *"Notice no buttons, no typing, no edit affordances — pure conversation."*

### Scenario 2: Another one, in flowing dialogue

🎤 *"Also add a LinkedIn post at 5 PM."*

**Expected:** New task appears at `5:00 PM`. Assistant: *"Got it, LinkedIn post scheduled for 5 PM."*

---

## Section 2 — Update + Context (1.5 min)

### Scenario 3: Direct reference

🎤 *"Change the LinkedIn task to 6 PM."*

**Expected:**
- The LinkedIn task on the right panel updates **in place** (time changes from 5 → 6 PM)
- Assistant: *"Moved the LinkedIn post to 6 PM."*

### Scenario 4: Context reference — "the previous one"

🎤 *"Actually, move the previous one to 7 PM."*

**Expected:**
- LinkedIn task again — assistant resolves "the previous one" from working memory
- *"Sure, the LinkedIn post is now at 7 PM."*

**Point out:** *"The working-memory stack on the server tracks the last 8 tasks I've referenced, so 'the previous one' is unambiguous even though I didn't name it."*

---

## Section 3 — Read with natural time understanding (1 min)

### Scenario 5: Time-of-day filter

🎤 *"What are today's evening tasks?"*

**Expected:** Assistant summarizes **conversationally** (not a bulleted list):
> *"You've got the LinkedIn post at 7 PM."*

If you have multiple evening tasks, it should string them together naturally: *"a product sync at 6 and a LinkedIn post at 7."*

### Scenario 6: Agenda summary

🎤 *"Give me a brief about today's agenda."*

**Expected:** Natural narrative — *"You're starting with the PM sync at 10, then a LinkedIn post at 7."* Not a numbered list, not "Task 1: …".

---

## Section 4 — Ordinal references (1 min)

### Scenario 7: Multi-create

🎤 *"Create three tasks for tomorrow morning. Gym at 7 AM, team sync at 9 AM, and post on LinkedIn at 11 AM."*

**Expected:**
- All three tasks appear in the **Tomorrow** group of the task list — usually within ~2 seconds because they're parallel tool calls
- Assistant: *"All three are in for tomorrow — gym at 7, team sync at 9, LinkedIn at 11."*

**Point out:** *"This was a single LLM call that emitted three parallel `create_task` tool invocations. The assistant doesn't need to round-trip per task."*

### Scenario 8: Ordinal reference

🎤 *"Move the second one to tomorrow afternoon."*

**Expected:**
- The **team sync** moves to a tomorrow-afternoon slot (default 2 PM)
- Assistant: *"Team sync moved to 2 PM tomorrow."*

**Point out:** *"Notice how 'the second one' resolves to the team sync — not by exact title, but by position in the list the assistant just read back to me."*

---

## Section 5 — Semantic understanding (30 s)

### Scenario 9: Fuzzy semantic match

🎤 *"Move my evening workout to 8 PM."*  (Make sure you've created a gym/workout task first.)

**Expected:**
- The gym task is found via similarity (gym ≈ workout) + evening time bucket
- Assistant: *"Moved the gym session to 8 PM."*

**Point out:** *"I called it 'workout' but the task is named 'gym' — the Sørensen-Dice bigram match + time-of-day filter find it anyway."*

---

## Section 6 — Delete with confirmation (1 min) ⭐

### Scenario 10: Destructive op requires explicit yes

🎤 *"Delete the LinkedIn task."*

**Expected:**
- Orb flips to **AMBER pulsing** (the AWAITING_CONFIRM state)
- Assistant: *"Are you sure you want to delete the LinkedIn post task? Please say yes or no."*
- Task is **not yet deleted** in the right panel

🎤 *"Yes."*

**Expected:**
- Task vanishes from the panel
- Orb returns to IDLE / GREEN briefly while it confirms
- Assistant: *"Done, the LinkedIn post is gone."*

**Point out:** *"The confirmation is enforced server-side by a state machine, not just by prompting. Even if the LLM hallucinated `confirmed: true`, the session-level guard would override it. I have a unit test for that exact scenario in `apps/realtime/src/__tests__/task-tools.test.ts`."*

### Scenario 11: Ambiguity → clarifying question

🎤 *"Delete the 9:15 task."*  (You don't have one — you have a 9 AM team sync.)

**Expected:**
- Assistant: *"I couldn't find a 9:15 task. Did you mean the 9 AM team sync?"*
- Lists candidates if there are multiple

🎤 *"Yes."* (Or *"No, never mind."*)

---

## Section 7 — Barge-in / Interruption (45 s) ⭐

### Scenario 12: Interrupting a long answer

1. Ask the assistant to summarize: 🎤 *"What's on my schedule today and tomorrow?"*
2. As soon as the assistant starts speaking ("You have a sync at 10, a Linke…") — **interrupt:**
3. 🎤 *"No, just tell me about tomorrow."*

**Expected:**
- Audio cuts immediately — within ~150 ms
- Orb flips back to LISTENING (blue)
- The new request flows through cleanly: *"Tomorrow you have gym at 7, team sync at 2, and LinkedIn at 11."*

**Point out:** *"The browser-side Silero VAD detects my speech even during TTS playback, fires an `interrupt` message over the WebSocket, the server aborts the in-flight TTS + LLM streams, and we're back to listening in one round-trip."*

---

## Section 8 — Failure handling (30 s)

### Scenario 13: Low STT confidence

Whisper or mumble: 🎤 *"...mumble mumble at three..."*

**Expected:** Assistant doesn't guess. *"Sorry, I didn't quite catch that. Could you say it again?"*

### Scenario 14: Provider fallback (optional, requires manual ElevenLabs disable)

If you want to demo the fallback chain mid-recording, the cleanest way is to temporarily put a bad `ELEVENLABS_API_KEY` in the server's environment and restart, then say:

🎤 *"What's tomorrow's agenda?"*

**Expected:**
- Notice the `tts:` indicator under the orb flips from `elevenlabs` to `polly`
- Voice quality changes (still natural but slightly different timbre)
- No user-visible error

This is hard to set up live — easier to mention as a feature and show a screenshot.

---

## Section 9 — Bilingual demo (45 s, optional but high-value for Urban Ground)

### Scenario 15: Switch to German

1. Click the **DE** toggle in the top-right
2. The UI flips to German immediately
3. 🎤 *"Erstelle eine Aufgabe für Mittagessen um 13 Uhr."*

**Expected:**
- Task appears at `13:00 · Mittagessen`
- Assistant **responds in German**: *"Erledigt, Mittagessen um 13 Uhr ist eingetragen."*
- The voice is the multilingual ElevenLabs voice (Adam by default)

### Scenario 16: Cross-language context

Still in German: 🎤 *"Verschiebe die vorherige auf 14 Uhr."*

**Expected:** Lunch moves to 14:00. Assistant: *"Mittagessen ist jetzt um 14 Uhr."*

**Point out:** *"Berlin company — multilingual users matter. Same orchestrator, same tools, the only thing that changes is the system prompt and the TTS voice."*

---

## Section 10 — Architectural callouts (optional, on-screen narration)

If you have ~30s left, do a quick "look under the hood":

1. **Latency telemetry** — the small text under the orb shows the heartbeat round-trip in ms. Below 80 ms = healthy.
2. **Provider transparency** — the `tts:` label shows which provider answered. If you keep the demo focused you should see `elevenlabs` throughout.
3. **Open the Network tab** — show the WebSocket frames. Point out the JSON control messages alongside the binary audio frames.
4. **Open the GitHub repo** — show the README architecture diagram briefly.

---

## What to point out in voice-over (Loom narration cheat sheet)

| Moment | Say something like |
|---|---|
| First task created | *"End-to-end ~900 ms from end-of-speech to assistant's first word."* |
| "the previous one" | *"That works because the server tracks an 8-task working memory stack."* |
| Three parallel creates | *"Single LLM call, three tool invocations in parallel."* |
| Delete confirmation | *"This guard is in a server-side state machine, not just in the prompt — I unit-tested the bypass attempt."* |
| Interruption | *"Browser VAD runs even during TTS playback so we can detect barge-in."* |
| Provider fallback (if shown) | *"ElevenLabs → Polly → browser SpeechSynthesis chain, primed-stream pattern."* |
| German | *"Same code path, just different system prompt + voice ID."* |
| Closing | *"Hybrid AWS + best-of-breed voice vendors. ~$0.03 per session at scale, ~$0 during the assessment."* |

---

## Troubleshooting during a live demo

| Symptom | Quick fix |
|---|---|
| Mic icon not showing in browser bar | Reload, check Chrome's site settings for `mic = Allow` |
| Orb stuck on LISTENING | VAD never endpointed — pause 2 s, then tap orb to stop mic |
| Orb stuck on THINKING | LLM timeout (12 s); tap orb to interrupt + retry |
| Audio plays but cuts off | MSE codec issue; check that ElevenLabs is returning MP3 (it is by default) |
| No audio at all | Browser autoplay block — tap the orb once before talking |
| "Sign in to continue" | `ALLOW_ANONYMOUS=false` and Cognito not configured. Set `ALLOW_ANONYMOUS=true` in `apps/realtime/.env` for local dev |
| Task list empty after create | `apps/realtime` not connected to DDB — `docker compose ps` should show `vtm-dynamodb-local Up` |

---

## Recording suggestions

- **Length target:** 5–7 minutes. The submission rubric usually has a hard 10-minute cap.
- **Audio quality:** use a real mic, not laptop built-in. The demo is *about* voice — bad audio undermines the message.
- **Cursor:** keep it visible. Click the orb deliberately so the reviewer can follow.
- **Pacing:** pause for 1–2 seconds after the assistant finishes speaking before launching your next request — gives a viewer time to process what they just saw.
- **First take is usually best.** Don't re-record because of a minor stutter — natural speech is the whole point.
- **Upload to Loom or Drive** unlisted, share the link in your submission email.
