// Signalling: how two members' computers find each other to open a direct
// connection. A message says hello, or carries one side's connection offer or
// answer (its session description, with every address it can be reached at).
// It is sealed with the room key like every entry, so whatever carries it (a
// public Nostr relay, a WebTorrent tracker, the studio's relay, the shared
// folder) sees only an opaque blob under a topic that changes every day.

import { openEntry, sealEntry, type Room } from "../crypto/room";

export type SignalType = "hello" | "offer" | "answer";

export interface Signal {
  v: 1;
  kind: "signal";
  by: string;
  /** The member it is for; "" for everyone. */
  to: string;
  type: SignalType;
  /** The sender's run: a new one each time it starts, so a restart is noticed. */
  session: string;
  /** The receiver's run an offer or answer belongs to; "" on a hello. */
  peerSession: string;
  sdp: string;
  /** The sender's wall clock. */
  at: number;
}

/** A signal older or newer than this, by the receiver's clock, is ignored. */
export const SIGNAL_MAX_AGE_MS = 5 * 60_000;

const TYPES: readonly SignalType[] = ["hello", "offer", "answer"];
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

export function readSignal(value: unknown): Signal | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!("v" in value) || value.v !== 1 || !("kind" in value) || value.kind !== "signal") return null;
  const by = "by" in value ? value.by : undefined;
  const to = "to" in value ? value.to : undefined;
  const type = "type" in value ? value.type : undefined;
  const session = "session" in value ? value.session : undefined;
  const peerSession = "peerSession" in value ? value.peerSession : undefined;
  const sdp = "sdp" in value ? value.sdp : undefined;
  const at = "at" in value ? value.at : undefined;
  if (!isText(by, 64) || by === "" || !isText(to, 64) || !isText(session, 64) || session === "") return null;
  if (!isText(peerSession, 64) || !isText(sdp, 64 * 1024) || typeof at !== "number" || !Number.isFinite(at)) return null;
  const kind = TYPES.find((t) => t === type);
  if (!kind) return null;
  return { v: 1, kind: "signal", by, to, type: kind, session, peerSession, sdp, at };
}

export const sealSignal = (room: Room, signal: Signal): Promise<string> => sealEntry(room, signal);

/** The signal `blob` holds, or null when it isn't one sealed for this room or
 *  is too old or too far ahead to act on. */
export async function openSignal(room: Room, blob: string, now: number): Promise<Signal | null> {
  const signal = readSignal(await openEntry(room, blob));
  if (!signal || Math.abs(now - signal.at) > SIGNAL_MAX_AGE_MS) return null;
  return signal;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The topic public services know the room's signals by today: a hash of the
 *  room id and the UTC day, so it says nothing about the room and doesn't
 *  link one day's members to the next. */
export const signalTopic = (roomId: string, now: number): Promise<string> =>
  sha256Hex(`studio-collab/signal/1/${roomId}/${Math.floor(now / 86_400_000)}`);

export type BusPhase = "connecting" | "live" | "offline";

/** One way of carrying signals: it sends a blob to every member listening on
 *  the same topic and hands on what others send. */
export interface SignalBus {
  readonly name: string;
  start(topic: string, receive: (blob: string) => void): void;
  /** Move to another topic (the day changed). */
  retopic(topic: string): void;
  send(blob: string): void;
  phase(): BusPhase;
  stop(): void;
}

/** Several buses as one: a blob goes out on all of them, and one heard on
 *  several is handed on once. */
export class SignalMux {
  private readonly buses: SignalBus[];
  private readonly seen = new Map<string, number>();

  constructor(buses: SignalBus[]) {
    this.buses = buses;
  }

  start(topic: string, receive: (blob: string) => void): void {
    const once = (blob: string) => {
      const now = Date.now();
      for (const [b, at] of this.seen) if (now - at > SIGNAL_MAX_AGE_MS) this.seen.delete(b);
      if (this.seen.has(blob)) return;
      this.seen.set(blob, now);
      receive(blob);
    };
    for (const bus of this.buses) bus.start(topic, once);
  }

  retopic(topic: string): void {
    for (const bus of this.buses) bus.retopic(topic);
  }

  send(blob: string): void {
    this.seen.set(blob, Date.now());
    for (const bus of this.buses) bus.send(blob);
  }

  phases(): { name: string; phase: BusPhase }[] {
    return this.buses.map((b) => ({ name: b.name, phase: b.phase() }));
  }

  stop(): void {
    for (const bus of this.buses) bus.stop();
  }
}
