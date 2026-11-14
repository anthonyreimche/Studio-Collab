// In-memory stand-ins for a public Nostr relay and a WebTorrent tracker, each
// keeping to its protocol: the relay checks event ids and signatures and
// passes events to matching subscriptions; the tracker hands each offer of an
// announce to one other peer of the swarm. They record what they see, so a
// test can check it learns nothing of the room.

import { schnorr } from "@noble/curves/secp256k1";
import type { SocketLike } from "../../src/transport/relay";
import { nostrEventId, type NostrEvent } from "../../src/realtime/nostr";

type Listener = (event: { data: unknown }) => void;

/** One end of an in-memory WebSocket; the server holds the other. */
export class FakeSocket implements SocketLike {
  private readonly listeners = new Map<string, Set<Listener>>();
  closed = false;
  constructor(private readonly toServer: (text: string) => void, private readonly onClose: () => void) {}

  send(text: string): void {
    if (!this.closed) queueMicrotask(() => this.toServer(text));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
    this.emit("close", { data: null });
  }
  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }
  emit(type: string, event: { data: unknown }): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
  deliver(text: string): void {
    if (!this.closed) queueMicrotask(() => this.emit("message", { data: text }));
  }
}

function openLater(socket: FakeSocket): FakeSocket {
  queueMicrotask(() => socket.emit("open", { data: null }));
  return socket;
}

export class FakeNostrRelay {
  readonly seen: string[] = [];
  readonly rejected: string[] = [];
  private readonly subs = new Map<FakeSocket, Map<string, { kinds: number[]; tags: string[] }>>();

  connect = (): FakeSocket => {
    const socket: FakeSocket = new FakeSocket(
      (text) => this.receive(socket, text),
      () => this.subs.delete(socket),
    );
    this.subs.set(socket, new Map());
    return openLater(socket);
  };

  private receive(socket: FakeSocket, text: string): void {
    this.seen.push(text);
    const msg: unknown = JSON.parse(text);
    if (!Array.isArray(msg)) return;
    if (msg[0] === "REQ") this.subs.get(socket)?.set(String(msg[1]), { kinds: msg[2].kinds, tags: msg[2]["#t"] });
    if (msg[0] === "CLOSE") this.subs.get(socket)?.delete(String(msg[1]));
    if (msg[0] !== "EVENT") return;
    const event: NostrEvent = msg[1];
    const valid = nostrEventId(event) === event.id && schnorr.verify(event.sig, event.id, event.pubkey);
    socket.deliver(JSON.stringify(["OK", event.id, valid, valid ? "" : "invalid: bad signature"]));
    if (!valid) {
      this.rejected.push(event.id);
      return;
    }
    for (const [peer, subs] of this.subs)
      for (const [id, filter] of subs)
        if (filter.kinds.includes(event.kind) && event.tags.some((t) => t[0] === "t" && filter.tags.includes(t[1])))
          peer.deliver(JSON.stringify(["EVENT", id, event]));
  }
}

export class FakeTracker {
  readonly seen: string[] = [];
  private readonly swarms = new Map<string, Map<string, FakeSocket>>();

  connect = (): FakeSocket => {
    const socket: FakeSocket = new FakeSocket(
      (text) => this.receive(socket, text),
      () => {
        for (const swarm of this.swarms.values()) for (const [id, s] of swarm) if (s === socket) swarm.delete(id);
      },
    );
    return openLater(socket);
  };

  private receive(socket: FakeSocket, text: string): void {
    this.seen.push(text);
    const msg = JSON.parse(text);
    if (msg.action !== "announce") return;
    const swarm = this.swarms.get(msg.info_hash) ?? new Map<string, FakeSocket>();
    this.swarms.set(msg.info_hash, swarm);
    swarm.set(msg.peer_id, socket);
    socket.deliver(JSON.stringify({ action: "announce", interval: 120, info_hash: msg.info_hash, complete: 0, incomplete: swarm.size }));
    const others = [...swarm].filter(([id]) => id !== msg.peer_id);
    (msg.offers ?? []).slice(0, others.length).forEach((o: { offer: unknown; offer_id: string }, i: number) => {
      others[i][1].deliver(
        JSON.stringify({ action: "announce", info_hash: msg.info_hash, peer_id: msg.peer_id, offer: o.offer, offer_id: o.offer_id }),
      );
    });
  }
}
