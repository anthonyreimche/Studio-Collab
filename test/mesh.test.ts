// Direct connections between members over real WebRTC (node-datachannel, on
// loopback) with signals over an in-memory bus: who offers, entries and
// presence down the channel, round trips, a restarted teammate, outsiders
// on the same bus, and a connection that never opens.

import nodeDataChannel from "node-datachannel";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { deriveRoom, makeRoomCode, type Room } from "../src/crypto/room";
import { PeerMesh, type CreatePeer, type PeerConnectionLike } from "../src/realtime/mesh";
import { adaptPeer } from "../src/realtime/rtc-adapter";

const ANA = "aaaaaaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbbbbbb";

const realPeer: CreatePeer = (config) => adaptPeer(new RTCPeerConnection(config));

const meshes: PeerMesh[] = [];
afterEach(() => {
  for (const m of meshes.splice(0)) m.stop();
});
afterAll(() => nodeDataChannel.cleanup());

class Bus {
  readonly members: PeerMesh[] = [];
  readonly sent: string[] = [];
  send = (from: PeerMesh) => (blob: string) => {
    this.sent.push(blob);
    for (const m of this.members) if (m !== from) setTimeout(() => m.receive(blob), 1);
  };
}

interface Heard {
  entries: { entries: string[]; from: string; at: number }[];
  presence: { data: string; from: string }[];
}

function mesh(room: Room, bus: Bus, member: string, createPeer: CreatePeer = realPeer, extra: Partial<ConstructorParameters<typeof PeerMesh>[0]> = {}) {
  const heard: Heard = { entries: [], presence: [] };
  const m: PeerMesh = new PeerMesh({
    room,
    memberId: member,
    send: (blob) => bus.send(m)(blob),
    createPeer,
    iceServers: [],
    onEntries: (entries, from) => heard.entries.push({ entries, from, at: performance.now() }),
    onPresence: (data, from) => heard.presence.push({ data, from }),
    gatherMs: 2000,
    ...extra,
  });
  bus.members.push(m);
  meshes.push(m);
  return { m, heard };
}

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("PeerMesh over real WebRTC", () => {
  it("connects two members once, however both start, and carries entries both ways in milliseconds", async () => {
    const room = await deriveRoom(makeRoomCode());
    const bus = new Bus();
    const ana = mesh(room, bus, ANA);
    const ben = mesh(room, bus, BEN);
    const started = performance.now();
    ana.m.start();
    ben.m.start();
    await until(() => ana.m.links()[BEN]?.state === "open" && ben.m.links()[ANA]?.state === "open");
    const connectMs = performance.now() - started;

    const sentAt = performance.now();
    ana.m.broadcastEntries(["s1.from-ana"]);
    await until(() => ben.heard.entries.length === 1);
    const oneWayMs = ben.heard.entries[0].at - sentAt;
    ben.m.broadcastPresence("s1.ben-here");
    await until(() => ana.heard.presence.length === 1);

    expect(ben.heard.entries[0]).toMatchObject({ entries: ["s1.from-ana"], from: ANA });
    expect(ana.heard.presence[0]).toEqual({ data: "s1.ben-here", from: BEN });
    expect(Object.keys(ana.m.links())).toEqual([BEN]);
    expect(oneWayMs).toBeLessThan(250);
    await until(() => (ana.m.links()[BEN]?.rttMs ?? null) !== null);
    console.info(`[mesh] connect ${connectMs.toFixed(0)} ms, one-way entry ${oneWayMs.toFixed(1)} ms, rtt ${ana.m.links()[BEN].rttMs} ms`);
  });

  it("reconnects to a teammate who restarted", async () => {
    const room = await deriveRoom(makeRoomCode());
    const bus = new Bus();
    const ana = mesh(room, bus, ANA);
    const ben = mesh(room, bus, BEN);
    ana.m.start();
    ben.m.start();
    await until(() => ana.m.links()[BEN]?.state === "open");
    ben.m.stop();
    bus.members.splice(bus.members.indexOf(ben.m), 1);
    const again = mesh(room, bus, BEN);
    again.m.start();
    await until(() => again.m.links()[ANA]?.state === "open");
    ana.m.broadcastEntries(["s1.after-restart"]);
    await until(() => again.heard.entries.length === 1);
  });

  it("ignores members of another room on the same bus", async () => {
    const bus = new Bus();
    const ana = mesh(await deriveRoom(makeRoomCode()), bus, ANA);
    const outsider = mesh(await deriveRoom(makeRoomCode()), bus, BEN);
    ana.m.start();
    outsider.m.start();
    await new Promise((r) => setTimeout(r, 300));
    await ana.m.settled();
    expect(ana.m.links()).toEqual({});
    expect(outsider.m.links()).toEqual({});
  });
});

describe("PeerMesh when a connection never opens", () => {
  it("gives it up after the time allowed and waits before trying again", async () => {
    const room = await deriveRoom(makeRoomCode());
    const bus = new Bus();
    let made = 0;
    const deadPeer: CreatePeer = () => {
      made++;
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
    const ana = mesh(room, bus, ANA, deadPeer, { connectMs: 100, helloEveryMs: 50 });
    const ben = mesh(room, bus, BEN, deadPeer, { connectMs: 100, helloEveryMs: 50 });
    ana.m.start();
    ben.m.start();
    await until(() => ana.m.links()[BEN]?.state === "connecting");
    await until(() => ana.m.links()[BEN] === undefined, 2000);
    const tries = made;
    await new Promise((r) => setTimeout(r, 400));
    expect(made).toBe(tries);
  });
});
