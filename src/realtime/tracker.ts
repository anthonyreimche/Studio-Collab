// Signals over public WebTorrent trackers (the WebSocket tracker protocol
// browsers use to find peers). A tracker passes each "offer" in an announce
// to one other peer in the swarm, untouched. Here the swarm is the day's
// topic and each offer's description is a sealed signal, sent in as many
// copies as there could be teammates; trackers learn neither the room nor
// anything in it.

import type { BusPhase, SignalBus } from "./signal";
import { SocketPool, type OpenSocket } from "./socket-bus";

export const PUBLIC_TRACKERS = ["wss://tracker.openwebtorrent.com", "wss://tracker.webtorrent.dev"] as const;

/** Copies of each signal, one per peer the tracker hands it to. */
const COPIES = 10;
const ANNOUNCE_MS = 60_000;

const randomText = (length: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
};

/** The 20-byte swarm id trackers expect, as a binary string, from a topic. */
export function infoHashOf(topic: string): string {
  let out = "";
  for (let i = 0; i < 40; i += 2) out += String.fromCharCode(parseInt(topic.slice(i, i + 2), 16));
  return out;
}

export class TrackerBus implements SignalBus {
  readonly name = "tracker";
  private readonly pool: SocketPool;
  private readonly peerId = randomText(20);
  private infoHash = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(trackers: readonly string[], openSocket: OpenSocket) {
    this.pool = new SocketPool(trackers, openSocket);
  }

  private announce(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      action: "announce",
      info_hash: this.infoHash,
      peer_id: this.peerId,
      uploaded: 0,
      downloaded: 0,
      numwant: COPIES,
      ...extra,
    });
  }

  start(topic: string, receive: (blob: string) => void): void {
    this.infoHash = infoHashOf(topic);
    this.pool.start({
      opened: (_url, send) => send(this.announce({ event: "started", offers: [] })),
      message: (_url, text) => {
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof msg !== "object" || msg === null || !("offer" in msg) || !("peer_id" in msg)) return;
        if (msg.peer_id === this.peerId || !("info_hash" in msg) || msg.info_hash !== this.infoHash) return;
        const offer = msg.offer;
        if (typeof offer === "object" && offer !== null && "sdp" in offer && typeof offer.sdp === "string") receive(offer.sdp);
      },
    });
    this.timer = setInterval(() => this.pool.each((send) => send(this.announce({ offers: [] }))), ANNOUNCE_MS);
  }

  retopic(topic: string): void {
    this.infoHash = infoHashOf(topic);
    this.pool.each((send) => send(this.announce({ event: "started", offers: [] })));
  }

  send(blob: string): void {
    const offers = Array.from({ length: COPIES }, () => ({ offer: { type: "offer", sdp: blob }, offer_id: randomText(20) }));
    this.pool.broadcast(this.announce({ offers }));
  }

  phase(): BusPhase {
    return this.pool.phase();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.pool.stop();
  }
}
