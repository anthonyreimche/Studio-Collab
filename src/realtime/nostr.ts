// Signals over public Nostr relays (NIP-01). A relay passes on any event whose
// signature checks out to whoever asked for its kind and tag, and doesn't keep
// events of an ephemeral kind (20000 to 29999). Each run signs with a key of
// its own, made at start and never kept; the event's tag is the day's topic
// and its content a sealed signal, so a relay learns neither the room nor
// anything in it.

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import type { BusPhase, SignalBus } from "./signal";
import { SocketPool, type OpenSocket } from "./socket-bus";

export const NOSTR_KIND = 25_331;

export const PUBLIC_NOSTR_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"] as const;

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export function nostrEventId(e: Pick<NostrEvent, "pubkey" | "created_at" | "kind" | "tags" | "content">): string {
  return hex(sha256(new TextEncoder().encode(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
}

export function signNostrEvent(secretKey: Uint8Array, kind: number, tags: string[][], content: string, now: number): NostrEvent {
  const pubkey = hex(schnorr.getPublicKey(secretKey));
  const created_at = Math.floor(now / 1000);
  const id = nostrEventId({ pubkey, created_at, kind, tags, content });
  return { id, pubkey, created_at, kind, tags, content, sig: hex(schnorr.sign(id, secretKey)) };
}

function isEvent(v: unknown): v is NostrEvent {
  return (
    typeof v === "object" &&
    v !== null &&
    "pubkey" in v &&
    "kind" in v &&
    "tags" in v &&
    "content" in v &&
    typeof v.pubkey === "string" &&
    typeof v.kind === "number" &&
    Array.isArray(v.tags) &&
    typeof v.content === "string"
  );
}

export class NostrBus implements SignalBus {
  readonly name = "nostr";
  private readonly pool: SocketPool;
  private readonly secretKey = schnorr.utils.randomPrivateKey();
  private readonly pubkey = hex(schnorr.getPublicKey(this.secretKey));
  private readonly subId = `sc${Math.random().toString(36).slice(2, 10)}`;
  private topic = "";

  constructor(relays: readonly string[], openSocket: OpenSocket) {
    this.pool = new SocketPool(relays, openSocket);
  }

  private request(send: (text: string) => void): void {
    const since = Math.floor(Date.now() / 1000) - 60;
    send(JSON.stringify(["REQ", this.subId, { kinds: [NOSTR_KIND], "#t": [this.topic], since }]));
  }

  start(topic: string, receive: (blob: string) => void): void {
    this.topic = topic;
    this.pool.start({
      opened: (_url, send) => this.request(send),
      message: (_url, text) => {
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (!Array.isArray(msg) || msg[0] !== "EVENT" || msg[1] !== this.subId) return;
        const event: unknown = msg[2];
        if (!isEvent(event) || event.kind !== NOSTR_KIND || event.pubkey === this.pubkey) return;
        if (!event.tags.some((t) => t[0] === "t" && t[1] === this.topic)) return;
        receive(event.content);
      },
    });
  }

  retopic(topic: string): void {
    this.topic = topic;
    this.pool.each((send) => {
      send(JSON.stringify(["CLOSE", this.subId]));
      this.request(send);
    });
  }

  send(blob: string): void {
    const event = signNostrEvent(this.secretKey, NOSTR_KIND, [["t", this.topic]], blob, Date.now());
    this.pool.broadcast(JSON.stringify(["EVENT", event]));
  }

  phase(): BusPhase {
    return this.pool.phase();
  }

  stop(): void {
    this.pool.stop();
  }
}
