// The relay transport: the extension's side of the studio's own relay
// (relay/ in this repository). Over a WebSocket where Safelight lets the
// extension open one to the relay's address (api.sockets, after a restart),
// else over HTTPS requests that Safelight makes for it (api.network), with
// long polls standing in for the socket's pushes. Either way it keeps its
// place in the room's numbered stream, so it asks only for what it hasn't had.

import type { CollabTransport, ReceivedEntry, TransportSink } from "./types";

export interface RelayRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** What the transport needs of a WebSocket; the browser's has it. */
export interface SocketLike {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface RelayTransportOptions {
  /** The relay's https address, with any path it is served under. */
  baseUrl: string;
  roomId: string;
  token: string;
  memberId: string;
  mode: "socket" | "poll";
  fetch(url: string, init: RelayRequest): Promise<Response>;
  openSocket?(url: string): SocketLike;
  /** The last entry number taken, kept by the engine across launches. */
  cursor: { get(): number; set(n: number): void };
  /** The first and the longest wait between reconnects, in ms. */
  retryMs?: [number, number];
  /** How long a poll waits for news, in seconds. */
  pollWaitS?: number;
}

interface Message {
  type: string;
  [key: string]: unknown;
}

interface WireEntry {
  seq: number;
  data: string;
}

const PUSH_TIMEOUT_MS = 30_000;
const PING_EVERY_MS = 30_000;

const AUTH_DETAIL =
  "The relay turned this room down: the room code doesn't match the one the room was opened with on this relay.";

function isWireEntry(v: unknown): v is WireEntry {
  return (
    typeof v === "object" &&
    v !== null &&
    "seq" in v &&
    "data" in v &&
    typeof v.seq === "number" &&
    typeof v.data === "string"
  );
}

const wireEntries = (v: unknown): WireEntry[] => (Array.isArray(v) ? v.filter(isWireEntry) : []);

function messageOf(text: unknown): Message | null {
  if (typeof text !== "string") return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
      ? { ...value, type: value.type }
      : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RelayTransport implements CollabTransport {
  readonly kind = "relay";
  readonly realtime = true;
  private readonly opts: Required<Omit<RelayTransportOptions, "openSocket">> & Pick<RelayTransportOptions, "openSocket">;
  private readonly base: string;
  private sink: TransportSink | null = null;
  private stopped = false;
  private fatal = false;
  private retry: number;
  private socket: SocketLike | null = null;
  private connected = false;
  private nextRef = 1;
  private readonly pending = new Map<number, { resolve(): void; reject(e: Error): void }>();
  private readonly presenceSeen = new Map<string, string>();
  private abort = new AbortController();
  private pinger: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RelayTransportOptions) {
    this.opts = { ...opts, retryMs: opts.retryMs ?? [1000, 30_000], pollWaitS: opts.pollWaitS ?? 25 };
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.retry = this.opts.retryMs[0];
  }

  private roomUrl(endpoint: string): string {
    return `${this.base}/v1/rooms/${this.opts.roomId}/${endpoint}`;
  }

  start(sink: TransportSink): Promise<void> {
    this.sink = sink;
    this.stopped = false;
    sink.status({ phase: "connecting" });
    return new Promise((ready) => {
      if (this.opts.mode === "socket") this.connect(ready);
      else void this.pollLoop(ready);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.pinger) clearInterval(this.pinger);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "Bye");
    this.socket = null;
    this.failPending(new Error("Stopped"));
  }

  async publish(entries: string[]): Promise<void> {
    if (entries.length === 0) return;
    if (this.opts.mode === "poll") {
      const res = await this.opts.fetch(this.roomUrl("entries"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ entries }),
      });
      if (!res.ok) throw new Error(await this.problemOf(res));
      return;
    }
    const socket = this.socket;
    if (!socket || !this.connected) throw new Error("Not connected to the relay");
    const ref = this.nextRef++;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        reject(new Error("The relay didn't answer"));
      }, PUSH_TIMEOUT_MS);
      this.pending.set(ref, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      socket.send(JSON.stringify({ type: "push", ref, entries }));
    });
  }

  async publishPresence(entry: string): Promise<void> {
    if (this.opts.mode === "poll") {
      const res = await this.opts.fetch(this.roomUrl("presence"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ member: this.opts.memberId, data: entry }),
      });
      if (!res.ok) throw new Error(await this.problemOf(res));
      return;
    }
    if (this.socket && this.connected) this.socket.send(JSON.stringify({ type: "presence", data: entry }));
  }

  /** Over the socket only: the HTTPS mode has no way to pass signals on. */
  async publishSignal(blob: string): Promise<void> {
    if (this.socket && this.connected) this.socket.send(JSON.stringify({ type: "signal", data: blob }));
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" };
  }

  private async problemOf(res: Response): Promise<string> {
    if (res.status === 401) return AUTH_DETAIL;
    try {
      const body: unknown = await res.json();
      if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string")
        return body.message;
    } catch {
      /* the status says enough */
    }
    return `The relay answered ${res.status}`;
  }

  private deliver(entries: WireEntry[]): void {
    if (entries.length === 0) return;
    const received: ReceivedEntry[] = entries.map((e) => ({ data: e.data }));
    this.opts.cursor.set(Math.max(this.opts.cursor.get(), ...entries.map((e) => e.seq)));
    this.sink?.entries(received);
  }

  private presence(member: unknown, data: unknown): void {
    if (typeof member !== "string" || typeof data !== "string" || member === this.opts.memberId) return;
    if (this.presenceSeen.get(member) === data) return;
    this.presenceSeen.set(member, data);
    this.sink?.presence(data, member);
  }

  private reset(): void {
    this.opts.cursor.set(0);
    this.sink?.reset?.();
  }

  private failPending(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private backoff(): number {
    const wait = this.retry;
    this.retry = Math.min(this.retry * 2, this.opts.retryMs[1]);
    return wait;
  }

  private connect(ready: () => void): void {
    const open = this.opts.openSocket;
    if (!open) {
      this.sink?.status({ phase: "problem", detail: "Live connections aren't available" });
      ready();
      return;
    }
    let welcomeHead = -1;
    let socket: SocketLike;
    try {
      socket = open(`${this.base.replace(/^http/i, "ws")}/v1/rooms/${this.opts.roomId}/socket`);
    } catch (e) {
      this.sink?.status({ phase: "problem", detail: e instanceof Error ? e.message : String(e) });
      ready();
      return;
    }
    this.socket = socket;
    const caughtUp = () => {
      if (welcomeHead >= 0 && this.opts.cursor.get() >= welcomeHead) ready();
    };
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({ type: "hello", token: this.opts.token, after: this.opts.cursor.get(), member: this.opts.memberId }),
      );
    });
    socket.addEventListener("message", (event) => {
      const msg = messageOf(event.data);
      if (!msg) return;
      if (msg.type === "welcome") {
        this.connected = true;
        this.retry = this.opts.retryMs[0];
        welcomeHead = typeof msg.head === "number" ? msg.head : 0;
        this.sink?.status({ phase: "live" });
        if (this.pinger) clearInterval(this.pinger);
        this.pinger = setInterval(() => socket.send(JSON.stringify({ type: "ping" })), PING_EVERY_MS);
        caughtUp();
      } else if (msg.type === "entries") {
        this.deliver(wireEntries(msg.entries));
        caughtUp();
      } else if (msg.type === "reset") {
        welcomeHead = typeof msg.head === "number" ? msg.head : 0;
        this.reset();
        caughtUp();
      } else if (msg.type === "presence") {
        this.presence(msg.member, msg.data);
      } else if (msg.type === "signal") {
        if (typeof msg.data === "string" && typeof msg.member === "string") this.sink?.signal?.(msg.data, msg.member);
      } else if (msg.type === "ack" && typeof msg.ref === "number") {
        this.pending.get(msg.ref)?.resolve();
        this.pending.delete(msg.ref);
      } else if (msg.type === "error") {
        const code = typeof msg.code === "string" ? msg.code : "error";
        if (typeof msg.ref === "number") {
          this.pending.get(msg.ref)?.reject(new Error(code));
          this.pending.delete(msg.ref);
        }
        if (code === "auth") {
          this.fatal = true;
          this.sink?.status({ phase: "problem", detail: AUTH_DETAIL });
        } else if (code === "room-full") {
          this.sink?.status({ phase: "problem", detail: "The relay's room is full" });
        }
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      this.connected = false;
      if (this.pinger) clearInterval(this.pinger);
      this.failPending(new Error("The connection to the relay closed"));
      ready();
      if (this.stopped || this.fatal) return;
      this.sink?.status({ phase: "offline", detail: "Reconnecting to the relay" });
      this.reconnectTimer = setTimeout(() => this.connect(() => {}), this.backoff());
    });
  }

  private async pollLoop(ready: () => void): Promise<void> {
    let first = true;
    while (!this.stopped && !this.fatal) {
      try {
        const after = this.opts.cursor.get();
        const wait = first ? 0 : this.opts.pollWaitS;
        const res = await this.opts.fetch(`${this.roomUrl("entries")}?after=${after}&wait=${wait}`, {
          method: "GET",
          headers: this.headers(),
          timeoutMs: (wait + 15) * 1000,
          signal: this.abort.signal,
        });
        if (res.status === 401) {
          this.fatal = true;
          this.sink?.status({ phase: "problem", detail: AUTH_DETAIL });
          break;
        }
        if (!res.ok) throw new Error(await this.problemOf(res));
        const page: unknown = await res.json();
        if (typeof page !== "object" || page === null) throw new Error("The relay sent something unreadable");
        const head = "head" in page && typeof page.head === "number" ? page.head : 0;
        if (head < after) {
          this.reset();
          continue;
        }
        this.deliver(wireEntries("entries" in page ? page.entries : []));
        if ("presence" in page && Array.isArray(page.presence))
          for (const p of page.presence)
            if (typeof p === "object" && p !== null && "member" in p && "data" in p) this.presence(p.member, p.data);
        this.retry = this.opts.retryMs[0];
        this.sink?.status({ phase: "live" });
        const more = "more" in page && page.more === true;
        if (!more) {
          first = false;
          ready();
        }
      } catch (e) {
        if (this.stopped) break;
        this.sink?.status({ phase: "offline", detail: e instanceof Error ? e.message : String(e) });
        ready();
        await sleep(this.backoff());
      }
    }
    ready();
  }
}
