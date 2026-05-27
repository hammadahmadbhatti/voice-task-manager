"use client";

import { io, type Socket } from "socket.io-client";
import type { ClientMessage, ServerMessage } from "@vtm/shared";

/**
 * Socket.IO wrapper. Adds:
 *   - typed message channel (.msg)
 *   - typed audio channel (.audio binary)
 *   - heartbeat ping / latency tracking
 *   - automatic reconnect handled by socket.io (we just listen for events)
 */

export interface VtmSocketOptions {
  url: string;
  authToken: string | null;
  onMessage: (m: ServerMessage) => void;
  onAudio: (chunk: ArrayBuffer) => void;
  onConnectChange: (connected: boolean) => void;
  onLatency?: (ms: number) => void;
}

export class VtmSocket {
  private socket: Socket;
  private latencyTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingT = 0;

  constructor(private readonly opts: VtmSocketOptions) {
    this.socket = io(opts.url, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 8000,
      timeout: 10000,
      auth: opts.authToken ? { token: opts.authToken } : undefined
    });

    this.socket.on("connect", () => opts.onConnectChange(true));
    this.socket.on("disconnect", () => opts.onConnectChange(false));
    this.socket.on("connect_error", (err) => {
      // Surface to the UI as a transient error.
      console.warn("WS connect error", err);
    });

    this.socket.on("msg", (m: ServerMessage) => opts.onMessage(m));
    this.socket.on("audio", (data: ArrayBuffer | Uint8Array) => {
      // socket.io may deliver either ArrayBuffer (in the browser) or a
      // Uint8Array view (in the Node test harness). Normalize to ArrayBuffer.
      let buf: ArrayBuffer;
      if (data instanceof ArrayBuffer) {
        buf = data;
      } else {
        // Copy out of the view's underlying buffer so the caller owns the bytes.
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        buf = copy.buffer;
      }
      opts.onAudio(buf);
    });
    this.socket.on("pong", (_payload: { t: number }) => {
      if (this.lastPingT && this.opts.onLatency) {
        this.opts.onLatency(Date.now() - this.lastPingT);
      }
      this.lastPingT = 0;
    });

    // Application-layer heartbeat (above socket.io's transport pings).
    this.latencyTimer = setInterval(() => {
      this.lastPingT = Date.now();
      this.send({ type: "ping", t: this.lastPingT });
    }, 10_000);
  }

  send(msg: ClientMessage): void {
    if (!this.socket.connected) return;
    this.socket.emit("msg", msg);
  }

  sendAudio(frame: ArrayBuffer): void {
    if (!this.socket.connected) return;
    this.socket.emit("audio", frame);
  }

  close(): void {
    if (this.latencyTimer) clearInterval(this.latencyTimer);
    this.socket.removeAllListeners();
    this.socket.disconnect();
  }
}
