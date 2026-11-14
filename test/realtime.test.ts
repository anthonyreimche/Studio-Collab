// Engines over a shared folder with direct connections on top (real WebRTC on
// loopback): how fast a change crosses, which path each teammate shows, and
// what happens when a direct connection can't be made. Signals go through a
// fake public Nostr relay, or through the folder alone.

import nodeDataChannel from "node-datachannel";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createRelayServer } from "../relay/node/server.mjs";
import { deriveRoom, makeRoomCode, type Room } from "../src/crypto/room";
import type { CreatePeer, PeerConnectionLike } from "../src/realtime/mesh";
import { MeshTransport } from "../src/realtime/mesh-transport";
import { NostrBus } from "../src/realtime/nostr";
import { adaptPeer } from "../src/realtime/rtc-adapter";
import type { SignalBus } from "../src/realtime/signal";
import { Engine } from "../src/sync/engine";
import { memoryLocalStore } from "../src/sync/local-store";
import { FolderTransport } from "../src/transport/folder";
import { RelayTransport } from "../src/transport/relay";
import type { CollabTransport } from "../src/transport/types";
import { FakeNostrRelay } from "./support/fake-signal-servers";
import { nodeFolder } from "./support/node-folder";

const ANA = "aaaaaaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbbbbbb";
const P = "p:Day 1/IMG_0001.CR3";

const realPeer: CreatePeer = (config) => adaptPeer(new RTCPeerConnection(config));
const deadPeer: CreatePeer = () => {
  const pc: PeerConnectionLike = {
    localDescription: { type: "offer", sdp: "v=0" },
    iceGatheringState: "complete",
    connectionState: "new",
    createDataChannel: () => ({ readyState: "connecting", send: () => {}, close: () => {}, on: () => {}, onMessage: () => {} }),
    createOffer: async () => ({ type: "offer", sdp: "v=0" }),
    createAnswer: async () => ({ type: "answer", sdp: "v=0" }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    on: () => {},
    onChannel: () => {},
    close: () => {},
  };
  return pc;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
afterAll(() => nodeDataChannel.cleanup());

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-collab-rt-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Opts {
  durable: (member: string) => CollabTransport;
  createPeer: CreatePeer;
  buses?: () => SignalBus[];
}

async function member(room: Room, id: string, o: Opts) {
  const applied: { at: number; field: string }[] = [];
  const engine = new Engine({
    room,
    memberId: id,
    name: () => (id === ANA ? "Ana" : "Ben"),
    transport: () =>
      new MeshTransport({
        durable: o.durable(id),
        room,
        memberId: id,
        createPeer: o.createPeer,
        iceServers: [],
        publicBuses: o.buses?.() ?? [],
        mesh: { gatherMs: 1500, connectMs: 3000, helloEveryMs: 200 },
      }),
    store: memoryLocalStore(),
    onApplied: (a, local) => {
      if (!local) for (const x of a) applied.push({ at: performance.now(), field: x.field });
    },
  });
  cleanups.push(() => engine.stop());
  await engine.start();
  return { engine, applied };
}

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const linkOf = (engine: Engine, id: string) => engine.view().members.find((m) => m.id === id);

describe("direct connections over a shared folder", () => {
  it("finds a teammate through a public Nostr relay and brings a change across in well under a second", async () => {
    const room = await deriveRoom(makeRoomCode());
    const dir = tempDir();
    const relay = new FakeNostrRelay();
    const o: Opts = {
      durable: (id) => new FolderTransport({ root: nodeFolder(dir), roomId: room.roomId, memberId: id, pollMs: 60_000 }),
      createPeer: realPeer,
      buses: () => [new NostrBus(["wss://relay.example"], relay.connect)],
    };
    const ana = await member(room, ANA, o);
    const ben = await member(room, BEN, o);
    await until(() => linkOf(ana.engine, BEN)?.link === "direct" && linkOf(ben.engine, ANA)?.link === "direct");

    const t0 = performance.now();
    ana.engine.record([[P, "rating", 5]]);
    await until(() => ben.engine.state.value(P, "rating") === 5, 2000);
    const latency = ben.applied.find((a) => a.field === "rating")!.at - t0;
    console.info(`[realtime] record → teammate applied: ${latency.toFixed(1)} ms (includes the 100 ms batching)`);
    expect(latency).toBeLessThan(1000);
    await until(() => linkOf(ana.engine, BEN)?.rttMs !== null);
  });

  it("falls back to the folder for signalling when public signalling is off", async () => {
    const room = await deriveRoom(makeRoomCode());
    const dir = tempDir();
    const o: Opts = {
      durable: (id) => new FolderTransport({ root: nodeFolder(dir), roomId: room.roomId, memberId: id, pollMs: 30 }),
      createPeer: realPeer,
    };
    const ana = await member(room, ANA, o);
    const ben = await member(room, BEN, o);
    await until(() => linkOf(ana.engine, BEN)?.link === "direct", 15_000);
    ben.engine.record([[P, "flag", "pick"]]);
    await until(() => ana.engine.state.value(P, "flag") === "pick", 2000);
  });

  it("shows the folder as the path, and still syncs through it, when no direct connection can be made", async () => {
    const room = await deriveRoom(makeRoomCode());
    const dir = tempDir();
    const o: Opts = {
      durable: (id) => new FolderTransport({ root: nodeFolder(dir), roomId: room.roomId, memberId: id, pollMs: 30 }),
      createPeer: deadPeer,
    };
    const ana = await member(room, ANA, o);
    const ben = await member(room, BEN, o);
    ana.engine.record([[P, "label", "red"]]);
    await until(() => ben.engine.state.value(P, "label") === "red", 5000);
    await until(() => linkOf(ben.engine, ANA) !== undefined);
    expect(linkOf(ben.engine, ANA)).toMatchObject({ link: "folder", rttMs: null });
  });
});

describe("direct connections over the relay", () => {
  it("signal through the relay's socket, and show the relay as the path when direct fails", async () => {
    const server = createRelayServer();
    cleanups.push(() => server.close());
    const port = await server.listen(0, "127.0.0.1");
    const room = await deriveRoom(makeRoomCode());
    const relayFor = (id: string) => {
      let cursor = 0;
      return new RelayTransport({
        baseUrl: `http://127.0.0.1:${port}`,
        roomId: room.roomId,
        token: room.relayToken,
        memberId: id,
        mode: "socket",
        fetch: (url, init) => fetch(url, init),
        openSocket: (url) => new WebSocket(url),
        cursor: { get: () => cursor, set: (n) => void (cursor = n) },
      });
    };
    const direct = { durable: relayFor, createPeer: realPeer };
    const ana = await member(room, ANA, direct);
    const ben = await member(room, BEN, direct);
    await until(() => linkOf(ana.engine, BEN)?.link === "direct" && linkOf(ben.engine, ANA)?.link === "direct");

    const room2 = await deriveRoom(makeRoomCode());
    const relayFor2 = (id: string) => {
      let cursor = 0;
      return new RelayTransport({
        baseUrl: `http://127.0.0.1:${port}`,
        roomId: room2.roomId,
        token: room2.relayToken,
        memberId: id,
        mode: "socket",
        fetch: (url, init) => fetch(url, init),
        openSocket: (url) => new WebSocket(url),
        cursor: { get: () => cursor, set: (n) => void (cursor = n) },
      });
    };
    const cy = await member(room2, ANA, { durable: relayFor2, createPeer: deadPeer });
    const dee = await member(room2, BEN, { durable: relayFor2, createPeer: deadPeer });
    cy.engine.record([[P, "rating", 2]]);
    await until(() => dee.engine.state.value(P, "rating") === 2, 3000);
    await until(() => linkOf(dee.engine, ANA) !== undefined);
    expect(linkOf(dee.engine, ANA)?.link).toBe("relay");
  });
});
