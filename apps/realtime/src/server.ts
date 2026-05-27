import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server as IoServer, type Socket } from "socket.io";
import { ulid } from "ulid";
import type {
  ClientHello,
  ClientMessage,
  Locale,
  ServerMessage
} from "@vtm/shared";
import { allowedOrigins, config } from "./config.js";
import { logger } from "./utils/logger.js";
import { AuthError, verifyIdToken } from "./middleware/auth.js";
import { Session } from "./orchestrator/session.js";
import { DeepgramStream } from "./providers/stt-deepgram.js";
import { runTurn } from "./orchestrator/conversation-agent.js";
import { findTasks } from "./db/tasks-repo.js";
import { upsertUserFromIdentity } from "./db/users-repo.js";
import { closePool } from "./db/client.js";

/**
 * HTTP server (health + REST for task list) plus Socket.IO for the
 * voice channel. We use Socket.IO instead of raw WS because:
 *   - reconnection w/ exponential backoff is built in
 *   - binary frames are first-class
 *   - room/namespace primitives let us add multi-session later
 *
 * Socket.IO's framing overhead is tiny (<5 % vs raw WS for our payloads),
 * and the reliability win is worth it.
 */

const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin (no Origin header) and configured origins.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} not allowed`));
    },
    credentials: true
  })
);

// ---------- Health ----------

const startedAt = Date.now();
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptimeMs: Date.now() - startedAt,
    version: process.env.npm_package_version ?? "dev",
    node: process.version
  });
});

// ---------- REST: list tasks ----------

/**
 * Authoritative task list, polled by the frontend after task_event
 * notifications. We could push the full list over WS but pulling on
 * demand keeps the WS channel focused on conversation flow.
 */
app.get("/api/tasks", async (req, res) => {
  try {
    const token = (req.headers.authorization ?? "")
      .replace(/^Bearer\s+/i, "")
      .trim();
    // Identity comes from EITHER a JWT (authenticated) OR an x-anon-id
    // header (anonymous). Both paths resolve to the same DB user row as
    // the WebSocket session — that's the whole point of upserting users
    // by external_id on every entry.
    const anonId = readSingleHeader(req.headers["x-anon-id"]);
    const identity = await verifyIdToken(token || null, anonId);
    const user = await upsertUserFromIdentity(identity);

    const tasks = await findTasks({
      userId: user.id,
      status: (req.query.status as "pending" | "done" | "any") ?? "any",
      limit: 100
    });
    res.json({ tasks });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(401).json({ error: err.code, message: err.message });
    }
    logger.error({ err }, "GET /api/tasks failed");
    res.status(500).json({ error: "internal" });
  }
});

function readSingleHeader(h: string | string[] | undefined): string | null {
  if (!h) return null;
  return Array.isArray(h) ? h[0] ?? null : h;
}

// ---------- HTTP + Socket.IO ----------

const httpServer = createServer(app);
const io = new IoServer(httpServer, {
  cors: { origin: allowedOrigins, credentials: true },
  // Bigger ping interval/timeout — sometimes mic events block the event loop briefly.
  pingInterval: 20_000,
  pingTimeout: 30_000,
  maxHttpBufferSize: 1e6 // 1 MB; we send small PCM frames
});

interface Connection {
  socket: Socket;
  session: Session | null;
  stt: DeepgramStream | null;
  /** Latest interim transcript — used for context if user interrupts. */
  lastPartial: string;
}

io.on("connection", (socket: Socket) => {
  const conn: Connection = {
    socket,
    session: null,
    stt: null,
    lastPartial: ""
  };
  const remote = socket.handshake.address;
  logger.info({ socketId: socket.id, remote }, "Client connected");

  // -------- send helpers (typed) --------
  const send = (msg: ServerMessage): void => {
    socket.emit("msg", msg);
  };
  const sendAudio = (chunk: Uint8Array): void => {
    socket.emit("audio", chunk);
  };

  // -------- hello / handshake --------
  socket.on("msg", async (raw: ClientMessage) => {
    try {
      switch (raw.type) {
        case "hello":
          await handleHello(raw);
          break;
        case "start_listening":
          await handleStartListening();
          break;
        case "stop_listening":
          handleStopListening();
          break;
        case "interrupt":
          handleInterrupt();
          break;
        case "ping":
          send({ type: "pong", t: raw.t });
          break;
        default:
          logger.warn({ raw }, "Unknown client message");
      }
    } catch (err) {
      logger.error({ err, type: (raw as { type?: string }).type }, "Message handler threw");
      send({
        type: "error",
        code: "internal",
        message: "Something went wrong handling that message.",
        retryable: true
      });
    }
  });

  // Binary audio frames stream in on their own event for clarity.
  socket.on("audio", (chunk: ArrayBuffer | Buffer) => {
    if (!conn.stt) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    conn.stt.send(buf);
  });

  socket.on("disconnect", (reason) => {
    logger.info({ socketId: socket.id, reason }, "Client disconnected");
    conn.stt?.flushAndClose();
    conn.session?.abortInflight();
  });

  // -------- handlers --------

  async function handleHello(msg: ClientHello): Promise<void> {
    const identity = await verifyIdToken(msg.idToken, msg.anonId);
    const user = await upsertUserFromIdentity(identity);
    const sessionId = ulid();
    const locale: Locale = msg.locale === "de" ? "de" : "en";
    conn.session = new Session(
      sessionId,
      user.id,
      locale,
      msg.timezone || "Europe/Berlin",
      user.name ?? undefined
    );
    logger.info(
      {
        sessionId,
        userId: user.id,
        externalId: identity.externalId,
        locale,
        anon: identity.isAnonymous
      },
      "Session started"
    );
    send({
      type: "ready",
      sessionId,
      userId: user.id,
      anonymous: identity.isAnonymous,
      serverNow: new Date().toISOString()
    });
  }

  async function handleStartListening(): Promise<void> {
    if (!conn.session) {
      send({
        type: "error",
        code: "auth_failed",
        message: "Send 'hello' first.",
        retryable: false
      });
      return;
    }

    // Any previous STT session should be torn down first.
    conn.stt?.flushAndClose();
    conn.lastPartial = "";

    send({ type: "state", state: "LISTENING" });

    const stt = new DeepgramStream(conn.session.locale, {
      onPartial: (text, confidence) => {
        conn.lastPartial = text;
        send({ type: "stt_partial", text, confidence });
      },
      onFinal: async (text, confidence) => {
        send({ type: "stt_final", text, confidence });
        if (!conn.session) return;
        if (!text.trim()) return;

        // Low confidence path — ask user to repeat rather than guess
        if (confidence < 0.55) {
          const apology =
            conn.session.locale === "de"
              ? "Entschuldige, ich habe das nicht ganz verstanden. Kannst du das wiederholen?"
              : "Sorry, I didn't quite catch that. Could you say it again?";
          send({ type: "assistant_text", delta: apology, done: true });
          conn.session.pushTurn({
            role: "assistant",
            content: apology,
            timestamp: new Date().toISOString()
          });
          // Speak the apology
          const controller = new AbortController();
          conn.session.currentAbort = controller;
          const { speakDirect } = await import("./orchestrator/speak-direct.js");
          await speakDirect(conn.session, apology, send, sendAudio, controller.signal);
          conn.session.currentAbort = null;
          return;
        }

        // Run the turn with a fresh abort controller for barge-in
        const controller = new AbortController();
        conn.session.abortInflight();
        conn.session.currentAbort = controller;
        try {
          await runTurn({
            session: conn.session,
            userText: text,
            send,
            sendAudio,
            abortSignal: controller.signal
          });
        } finally {
          if (conn.session.currentAbort === controller) {
            conn.session.currentAbort = null;
          }
        }
      },
      onError: (err) => {
        logger.error({ err }, "STT error");
        send({
          type: "error",
          code: "stt_failed",
          message:
            "I'm having trouble hearing you. Could you try again?",
          retryable: true
        });
      },
      onClose: () => {
        // STT closed — happens after every utterance.
      }
    });
    stt.open();
    conn.stt = stt;
  }

  function handleStopListening(): void {
    conn.stt?.flushAndClose();
    conn.stt = null;
  }

  function handleInterrupt(): void {
    if (!conn.session) return;
    logger.debug("Interrupt received");
    conn.session.abortInflight();
    send({ type: "state", state: "IDLE" });
  }
});

// ---------- start ----------

httpServer.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      origins: allowedOrigins,
      env: config.NODE_ENV
    },
    `🎙  Realtime server listening`
  );
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  io.close();
  await closePool().catch((err) => logger.warn({ err }, "pool close error"));
  httpServer.close(() => process.exit(0));
  // Hard exit after 5s if anything hangs
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
