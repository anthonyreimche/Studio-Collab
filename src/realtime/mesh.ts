// Direct connections between the room's members: one WebRTC data channel to
// each teammate, found through signals (signal.ts). Entries and presence go
// straight down every open channel, so a change reaches a teammate on the
// same network or with a direct route in well under a second; the shared
// folder or the relay still carries everything, for whoever isn't connected.
//
// Of two members, the one whose id sorts first makes the offer, so two never
// offer to each other at once. Descriptions are sent whole, with every
// address gathered (no trickling), because a tracker passes one message each
// way. The channel's encryption (DTLS) is keyed by fingerprints inside the
// sealed descriptions, so only a member holding the room code can be on the
// other end.

import type { Room } from "../crypto/room";
import { openSignal, sealSignal, type Signal } from "./signal";

export interface SessionDescriptionLike {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
}

export interface DataChannelLike {
  readonly readyState: string;
  send(data: string): void;
  close(): void;
  on(type: "open" | "close", listener: () => void): void;
  onMessage(listener: (data: unknown) => void): void;
}

export interface PeerConnectionLike {
  readonly localDescription: SessionDescriptionLike | null;
  readonly iceGatheringState: string;
  readonly connectionState: string;
  createDataChannel(label: string, init?: { ordered?: boolean }): DataChannelLike;
  createOffer(): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(description?: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  on(type: "icegatheringstatechange" | "connectionstatechange", listener: () => void): void;
  onChannel(listener: (channel: DataChannelLike) => void): void;
  close(): void;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const PUBLIC_STUN: IceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
];

export type CreatePeer = (config: { iceServers: IceServer[] }) => PeerConnectionLike;

export interface PeerLink {
  state: "connecting" | "open";
  /** Round trip over the channel, in ms; null until measured. */
  rttMs: number | null;
}

export interface MeshOptions {
  room: Room;
  memberId: string;
  /** Send a sealed signal by every way there is. */
  send(blob: string): void;
  createPeer: CreatePeer;
  iceServers: IceServer[];
  onEntries(entries: string[], from: string): void;
  onPresence(data: string, from: string): void;
  onChange?(): void;
  now?: () => number;
  helloEveryMs?: number;
  /** How long gathering addresses may take before what was found is sent. */
  gatherMs?: number;
  /** How long a connection may take to open before it counts as failed. */
  connectMs?: number;
}

interface Peer {
  member: string;
  theirSession: string;
  pc: PeerConnectionLike;
  channel: DataChannelLike | null;
  state: "connecting" | "open";
  rttMs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

type Frame = { t: "e"; d: string[] } | { t: "p"; d: string } | { t: "ping"; n: number } | { t: "pong"; n: number };

function frameOf(data: unknown): Frame | null {
  if (typeof data !== "string") return null;
  try {
    const v: unknown = JSON.parse(data);
    if (typeof v !== "object" || v === null || !("t" in v) || !("d" in v || "n" in v)) return null;
    if (v.t === "e" && "d" in v && Array.isArray(v.d) && v.d.every((x) => typeof x === "string")) return { t: "e", d: v.d };
    if (v.t === "p" && "d" in v && typeof v.d === "string") return { t: "p", d: v.d };
    if ((v.t === "ping" || v.t === "pong") && "n" in v && typeof v.n === "number") return { t: v.t, n: v.n };
  } catch {
    return null;
  }
  return null;
}

const randomId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");

export class PeerMesh {
  private readonly opts: MeshOptions;
  private readonly now: () => number;
  private readonly session = randomId();
  private readonly peers = new Map<string, Peer>();
  /** When to try a member again after a failed connection, and how long to wait next time. */
  private readonly backoff = new Map<string, { until: number; waitMs: number }>();
  private readonly lastDirectedHello = new Map<string, number>();
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private work: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(opts: MeshOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    void this.hello("");
    this.helloTimer = setInterval(() => void this.hello(""), this.opts.helloEveryMs ?? 15_000);
    this.pingTimer = setInterval(() => this.ping(), 5000);
  }

  stop(): void {
    this.stopped = true;
    if (this.helloTimer) clearInterval(this.helloTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const member of [...this.peers.keys()]) this.drop(member);
  }

  /** A sealed signal heard on any bus. */
  receive(blob: string): void {
    this.work = this.work.then(() => this.handle(blob)).catch(() => {});
  }

  /** Resolves once every signal heard so far is handled. */
  async settled(): Promise<void> {
    await this.work;
  }

  broadcastEntries(entries: string[]): void {
    this.sendAll(JSON.stringify({ t: "e", d: entries }));
  }

  broadcastPresence(data: string): void {
    this.sendAll(JSON.stringify({ t: "p", d: data }));
  }

  links(): Record<string, PeerLink> {
    const out: Record<string, PeerLink> = {};
    for (const [member, peer] of this.peers) out[member] = { state: peer.state, rttMs: peer.rttMs };
    return out;
  }

  private sendAll(text: string): void {
    for (const peer of this.peers.values())
      if (peer.state === "open" && peer.channel?.readyState === "open") peer.channel.send(text);
  }

  private signal(fields: Pick<Signal, "to" | "type" | "peerSession" | "sdp">): Promise<void> {
    return sealSignal(this.opts.room, {
      v: 1,
      kind: "signal",
      by: this.opts.memberId,
      session: this.session,
      at: this.now(),
      ...fields,
    }).then((blob) => this.opts.send(blob));
  }

  private hello(to: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.signal({ to, type: "hello", peerSession: "", sdp: "" });
  }

  private async handle(blob: string): Promise<void> {
    if (this.stopped) return;
    const s = await openSignal(this.opts.room, blob, this.now());
    if (!s || s.by === this.opts.memberId || (s.to && s.to !== this.opts.memberId)) return;
    if (s.type === "hello") return this.onHello(s);
    if (s.type === "offer" && s.peerSession === this.session) return this.onOffer(s);
    if (s.type === "answer" && s.peerSession === this.session) return this.onAnswer(s);
  }

  private async onHello(s: Signal): Promise<void> {
    const held = this.peers.get(s.by);
    if (held && held.theirSession === s.session) return;
    if (held) this.drop(s.by);
    const wait = this.backoff.get(s.by);
    if (wait && this.now() < wait.until) return;
    if (this.opts.memberId < s.by) return this.offer(s.by, s.session);
    const last = this.lastDirectedHello.get(s.by) ?? 0;
    if (this.now() - last < 3000) return;
    this.lastDirectedHello.set(s.by, this.now());
    await this.hello(s.by);
  }

  private newPeer(member: string, theirSession: string): Peer {
    const pc = this.opts.createPeer({ iceServers: this.opts.iceServers });
    const peer: Peer = { member, theirSession, pc, channel: null, state: "connecting", rttMs: null, timer: null };
    this.peers.set(member, peer);
    peer.timer = setTimeout(() => {
      if (this.peers.get(member) === peer && peer.state !== "open") this.fail(member);
    }, this.opts.connectMs ?? 20_000);
    pc.on("connectionstatechange", () => {
      if (this.peers.get(member) === peer && pc.connectionState === "failed") this.fail(member);
    });
    this.opts.onChange?.();
    return peer;
  }

  private wire(peer: Peer, channel: DataChannelLike): void {
    peer.channel = channel;
    const opened = () => {
      if (this.peers.get(peer.member) !== peer) return;
      peer.state = "open";
      if (peer.timer) clearTimeout(peer.timer);
      this.backoff.delete(peer.member);
      this.ping();
      this.opts.onChange?.();
    };
    if (channel.readyState === "open") opened();
    else channel.on("open", opened);
    channel.on("close", () => {
      if (this.peers.get(peer.member) === peer) {
        this.drop(peer.member);
        this.opts.onChange?.();
      }
    });
    channel.onMessage((data) => {
      const frame = frameOf(data);
      if (!frame) return;
      if (frame.t === "e") this.opts.onEntries(frame.d, peer.member);
      else if (frame.t === "p") this.opts.onPresence(frame.d, peer.member);
      else if (frame.t === "ping") channel.send(JSON.stringify({ t: "pong", n: frame.n }));
      else {
        peer.rttMs = Math.max(0, Math.round(this.now() - frame.n));
        this.opts.onChange?.();
      }
    });
  }

  private ping(): void {
    this.sendAll(JSON.stringify({ t: "ping", n: this.now() }));
  }

  private async gathered(pc: PeerConnectionLike): Promise<void> {
    if (pc.iceGatheringState === "complete") return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.opts.gatherMs ?? 4000);
      pc.on("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  private async offer(member: string, theirSession: string): Promise<void> {
    const peer = this.newPeer(member, theirSession);
    this.wire(peer, peer.pc.createDataChannel("studio-collab", { ordered: true }));
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    await this.gathered(peer.pc);
    const sdp = peer.pc.localDescription?.sdp;
    if (this.peers.get(member) !== peer || !sdp) return;
    await this.signal({ to: member, type: "offer", peerSession: theirSession, sdp });
  }

  private async onOffer(s: Signal): Promise<void> {
    if (this.peers.has(s.by)) this.drop(s.by);
    const peer = this.newPeer(s.by, s.session);
    peer.pc.onChannel((channel) => this.wire(peer, channel));
    await peer.pc.setRemoteDescription({ type: "offer", sdp: s.sdp });
    await peer.pc.setLocalDescription(await peer.pc.createAnswer());
    await this.gathered(peer.pc);
    const sdp = peer.pc.localDescription?.sdp;
    if (this.peers.get(s.by) !== peer || !sdp) return;
    await this.signal({ to: s.by, type: "answer", peerSession: s.session, sdp });
  }

  private async onAnswer(s: Signal): Promise<void> {
    const peer = this.peers.get(s.by);
    if (!peer || peer.theirSession !== s.session || peer.state === "open") return;
    await peer.pc.setRemoteDescription({ type: "answer", sdp: s.sdp });
  }

  private fail(member: string): void {
    this.drop(member);
    const waitMs = Math.min((this.backoff.get(member)?.waitMs ?? 15_000) * 2, 5 * 60_000);
    this.backoff.set(member, { until: this.now() + waitMs, waitMs });
    this.opts.onChange?.();
  }

  private drop(member: string): void {
    const peer = this.peers.get(member);
    if (!peer) return;
    this.peers.delete(member);
    if (peer.timer) clearTimeout(peer.timer);
    try {
      peer.channel?.close();
      peer.pc.close();
    } catch {
      /* already closed */
    }
  }
}
