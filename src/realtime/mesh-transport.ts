// A durable transport (the shared folder or the relay) with direct
// connections on top. Every entry and presence goes down the direct channels
// at once and to the durable transport as well, so a teammate who is
// connected gets it in milliseconds and everyone else, or anyone catching up
// later, gets it the durable way. The engine skips whichever copy arrives
// second.
//
// Signals go out on every path there is: the durable transport (the relay's
// socket, or the folder as a slow last resort) and, unless the person turned
// it off, public Nostr relays and WebTorrent trackers.

import type { Room } from "../crypto/room";
import type { CollabTransport, TransportLink, TransportSink } from "../transport/types";
import { PeerMesh, type CreatePeer, type IceServer, type MeshOptions } from "./mesh";
import { SignalMux, signalTopic, type BusPhase, type SignalBus } from "./signal";

export interface MeshTransportOptions {
  durable: CollabTransport;
  room: Room;
  memberId: string;
  createPeer: CreatePeer;
  iceServers: IceServer[];
  /** Public signalling (Nostr, trackers); empty when turned off. */
  publicBuses: SignalBus[];
  now?: () => number;
  mesh?: Partial<Pick<MeshOptions, "gatherMs" | "connectMs" | "helloEveryMs">>;
}

/** The durable transport as a signal bus. */
class DurableBus implements SignalBus {
  readonly name: string;
  receive: ((blob: string) => void) | null = null;
  constructor(private readonly durable: CollabTransport) {
    this.name = durable.kind;
  }
  start(_topic: string, receive: (blob: string) => void): void {
    this.receive = receive;
  }
  retopic(): void {}
  send(blob: string): void {
    void this.durable.publishSignal?.(blob).catch(() => {});
  }
  phase(): BusPhase {
    return this.durable.publishSignal ? "live" : "offline";
  }
  stop(): void {}
}

const HOUR_MS = 3_600_000;

export class MeshTransport implements CollabTransport {
  readonly kind: string;
  readonly realtime = true;
  private readonly opts: MeshTransportOptions;
  private mesh: PeerMesh | null = null;
  private mux: SignalMux | null = null;
  private topicTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: MeshTransportOptions) {
    this.opts = opts;
    this.kind = opts.durable.kind;
  }

  async start(sink: TransportSink): Promise<void> {
    const { room, memberId, durable } = this.opts;
    const now = this.opts.now ?? Date.now;
    const durableBus = new DurableBus(durable);
    const mux = new SignalMux([durableBus, ...this.opts.publicBuses]);
    const mesh = new PeerMesh({
      room,
      memberId,
      send: (blob) => mux.send(blob),
      createPeer: this.opts.createPeer,
      iceServers: this.opts.iceServers,
      onEntries: (entries, from) => sink.entries(entries.map((data) => ({ data, origin: from }))),
      onPresence: (data, from) => sink.presence(data, from),
      onChange: () => sink.linksChanged?.(),
      now,
      ...this.opts.mesh,
    });
    this.mesh = mesh;
    this.mux = mux;
    let topic = await signalTopic(room.roomId, now());
    mux.start(topic, (blob) => mesh.receive(blob));
    this.topicTimer = setInterval(() => {
      void signalTopic(room.roomId, now()).then((next) => {
        if (next === topic) return;
        topic = next;
        mux.retopic(next);
      });
    }, HOUR_MS);
    await durable.start({ ...sink, signal: (blob) => durableBus.receive?.(blob) });
    mesh.start();
  }

  publish(entries: string[]): Promise<void> {
    this.mesh?.broadcastEntries(entries);
    return this.opts.durable.publish(entries);
  }

  publishPresence(entry: string): Promise<void> {
    this.mesh?.broadcastPresence(entry);
    return this.opts.durable.publishPresence(entry);
  }

  links(): Record<string, TransportLink> {
    return this.mesh?.links() ?? {};
  }

  /** Each signalling path and whether it is up, for the panel. */
  signalling(): { name: string; phase: BusPhase }[] {
    return this.mux?.phases() ?? [];
  }

  async stop(): Promise<void> {
    if (this.topicTimer) clearInterval(this.topicTimer);
    this.mesh?.stop();
    this.mux?.stop();
    await this.opts.durable.stop();
  }
}
