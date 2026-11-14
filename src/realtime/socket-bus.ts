// What the WebSocket signal buses share: one socket per server, reconnected
// with a growing wait, with messages sent while it is down kept briefly and
// sent once it is up.

import type { SocketLike } from "../transport/relay";
import type { BusPhase } from "./signal";

export type OpenSocket = (url: string) => SocketLike;

interface Server {
  url: string;
  socket: SocketLike | null;
  open: boolean;
  retryMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface SocketPoolHandlers {
  opened(url: string, send: (text: string) => void): void;
  message(url: string, text: string, send: (text: string) => void): void;
}

const QUEUE_MS = 20_000;

export class SocketPool {
  private readonly servers: Server[];
  private readonly openSocket: OpenSocket;
  private handlers: SocketPoolHandlers | null = null;
  private queue: { text: string; at: number }[] = [];
  private stopped = false;

  constructor(urls: readonly string[], openSocket: OpenSocket) {
    this.servers = urls.map((url) => ({ url, socket: null, open: false, retryMs: 2000, timer: null }));
    this.openSocket = openSocket;
  }

  start(handlers: SocketPoolHandlers): void {
    this.handlers = handlers;
    this.stopped = false;
    for (const server of this.servers) this.connect(server);
  }

  /** Send to every server that is up; keep it for those that come up soon. */
  broadcast(text: string): void {
    const now = Date.now();
    this.queue = [...this.queue.filter((q) => now - q.at < QUEUE_MS), { text, at: now }];
    for (const s of this.servers) if (s.open) s.socket?.send(text);
  }

  /** Send to every server that is up, now only. */
  each(make: (send: (text: string) => void, url: string) => void): void {
    for (const s of this.servers) {
      const socket = s.socket;
      if (s.open && socket) make((text) => socket.send(text), s.url);
    }
  }

  phase(): BusPhase {
    if (this.servers.some((s) => s.open)) return "live";
    return this.servers.some((s) => s.socket) ? "connecting" : "offline";
  }

  stop(): void {
    this.stopped = true;
    for (const s of this.servers) {
      if (s.timer) clearTimeout(s.timer);
      s.socket?.close(1000, "Bye");
      s.socket = null;
      s.open = false;
    }
  }

  private connect(server: Server): void {
    if (this.stopped) return;
    let socket: SocketLike;
    try {
      socket = this.openSocket(server.url);
    } catch {
      this.later(server);
      return;
    }
    server.socket = socket;
    const send = (text: string) => socket.send(text);
    socket.addEventListener("open", () => {
      server.open = true;
      server.retryMs = 2000;
      this.handlers?.opened(server.url, send);
      const now = Date.now();
      for (const q of this.queue) if (now - q.at < QUEUE_MS) send(q.text);
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.handlers?.message(server.url, event.data, send);
    });
    socket.addEventListener("close", () => {
      if (server.socket !== socket) return;
      server.socket = null;
      server.open = false;
      this.later(server);
    });
  }

  private later(server: Server): void {
    if (this.stopped) return;
    server.timer = setTimeout(() => this.connect(server), server.retryMs);
    server.retryMs = Math.min(server.retryMs * 2, 60_000);
  }
}
