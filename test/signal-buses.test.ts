// Signals: sealed, dated and checked; carried over Nostr relays and WebTorrent
// trackers that see only opaque blobs under a day's topic; heard once however
// many buses carry them.

import { describe, expect, it } from "vitest";
import { deriveRoom, makeRoomCode, sealEntry } from "../src/crypto/room";
import { NostrBus } from "../src/realtime/nostr";
import { SignalMux, openSignal, sealSignal, signalTopic, type Signal, type SignalBus } from "../src/realtime/signal";
import { TrackerBus } from "../src/realtime/tracker";
import { FakeNostrRelay, FakeTracker } from "./support/fake-signal-servers";

const ANA = "aaaaaaaaaaaaaaaa";
const NOW = 1_763_000_000_000;

const hello = (at = NOW): Signal => ({
  v: 1,
  kind: "signal",
  by: ANA,
  to: "",
  type: "offer",
  session: "s1",
  peerSession: "s2",
  sdp: "v=0\r\nc=IN IP4 192.168.1.20\r\na=candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host\r\n",
  at,
});

async function until(check: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("sealed signals", () => {
  it("open in the same room and nowhere else", async () => {
    const room = await deriveRoom(makeRoomCode());
    const other = await deriveRoom(makeRoomCode());
    const blob = await sealSignal(room, hello());
    expect(blob).not.toContain("192.168");
    expect(await openSignal(room, blob, NOW)).toEqual(hello());
    expect(await openSignal(other, blob, NOW)).toBeNull();
  });

  it("are ignored when too old, or when they aren't signals", async () => {
    const room = await deriveRoom(makeRoomCode());
    expect(await openSignal(room, await sealSignal(room, hello(NOW - 6 * 60_000)), NOW)).toBeNull();
    expect(await openSignal(room, await sealEntry(room, { v: 1, kind: "presence", by: ANA, wall: NOW }), NOW)).toBeNull();
    expect(await openSignal(room, await sealEntry(room, { ...hello(), type: "shout" }), NOW)).toBeNull();
  });

  it("go under a topic that hides the room and changes with the day", async () => {
    const room = await deriveRoom(makeRoomCode());
    const today = await signalTopic(room.roomId, NOW);
    expect(today).toMatch(/^[0-9a-f]{64}$/);
    expect(today).not.toContain(room.roomId);
    expect(await signalTopic(room.roomId, NOW + 60_000)).toBe(today);
    expect(await signalTopic(room.roomId, NOW + 86_400_000)).not.toBe(today);
  });
});

function pair(make: () => SignalBus) {
  const a = make();
  const b = make();
  const heardByA: string[] = [];
  const heardByB: string[] = [];
  a.start("t".repeat(64), (blob) => heardByA.push(blob));
  b.start("t".repeat(64), (blob) => heardByB.push(blob));
  return { a, b, heardByA, heardByB };
}

describe("NostrBus", () => {
  it("carries a blob to the other member through every relay, signed so relays take it", async () => {
    const relays = [new FakeNostrRelay(), new FakeNostrRelay()];
    const open = (url: string) => (url.includes("one") ? relays[0] : relays[1]).connect();
    const { a, b, heardByA, heardByB } = pair(() => new NostrBus(["wss://one.example", "wss://two.example"], open));
    await until(() => a.phase() === "live" && b.phase() === "live");
    a.send("s1.blob-from-a");
    await until(() => heardByB.length >= 2);
    expect(heardByB).toEqual(["s1.blob-from-a", "s1.blob-from-a"]);
    expect(heardByA).toEqual([]);
    expect(relays.every((r) => r.rejected.length === 0)).toBe(true);
    a.stop();
    b.stop();
  });

  it("moves to a new topic and stops hearing the old one", async () => {
    const relay = new FakeNostrRelay();
    const { a, b, heardByB } = pair(() => new NostrBus(["wss://one.example"], relay.connect));
    await until(() => a.phase() === "live" && b.phase() === "live");
    b.retopic("u".repeat(64));
    await new Promise((r) => setTimeout(r, 10));
    a.send("s1.old-topic");
    await new Promise((r) => setTimeout(r, 20));
    expect(heardByB).toEqual([]);
    a.retopic("u".repeat(64));
    await new Promise((r) => setTimeout(r, 10));
    a.send("s1.new-topic");
    await until(() => heardByB.length === 1);
    a.stop();
    b.stop();
  });
});

describe("TrackerBus", () => {
  it("carries a blob to the other peer of the swarm", async () => {
    const tracker = new FakeTracker();
    const { a, b, heardByA, heardByB } = pair(() => new TrackerBus(["wss://tracker.example"], tracker.connect));
    await until(() => a.phase() === "live" && b.phase() === "live");
    await new Promise((r) => setTimeout(r, 10));
    b.send("s1.blob-from-b");
    await until(() => heardByA.length === 1);
    expect(heardByA).toEqual(["s1.blob-from-b"]);
    expect(heardByB).toEqual([]);
    a.stop();
    b.stop();
  });
});

describe("public servers see nothing of the room", () => {
  it("only a day's topic and sealed blobs pass through", async () => {
    const room = await deriveRoom(makeRoomCode());
    const topic = await signalTopic(room.roomId, NOW);
    const relay = new FakeNostrRelay();
    const tracker = new FakeTracker();
    const bus = new SignalMux([new NostrBus(["wss://r.example"], relay.connect), new TrackerBus(["wss://t.example"], tracker.connect)]);
    bus.start(topic, () => {});
    await new Promise((r) => setTimeout(r, 10));
    bus.send(await sealSignal(room, hello()));
    await until(() => relay.seen.some((s) => s.includes('"EVENT"')));
    const everything = [...relay.seen, ...tracker.seen].join("\n");
    for (const secret of [room.roomId, room.relayToken, ANA, "192.168", "candidate"]) expect(everything).not.toContain(secret);
    bus.stop();
  });
});

describe("SignalMux", () => {
  it("hands a blob heard on several buses on once", async () => {
    const relay = new FakeNostrRelay();
    const tracker = new FakeTracker();
    const make = () => new SignalMux([new NostrBus(["wss://r.example"], relay.connect), new TrackerBus(["wss://t.example"], tracker.connect)]);
    const a = make();
    const b = make();
    const heard: string[] = [];
    a.start("t".repeat(64), () => {});
    b.start("t".repeat(64), (blob) => heard.push(blob));
    await new Promise((r) => setTimeout(r, 20));
    a.send("s1.once");
    await until(() => heard.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(heard).toEqual(["s1.once"]);
    a.stop();
    b.stop();
  });
});
