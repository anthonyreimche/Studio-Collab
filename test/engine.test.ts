// The engine between two or three members over an in-memory medium: ops
// sealed and merged, duplicates and reorders, forged entries, a clock running
// ahead, going offline, restarting, and a medium that lost everything.

import { afterEach, describe, expect, it } from "vitest";
import { deriveRoom, makeRoomCode, sealEntry, type Room } from "../src/crypto/room";
import { Engine, type EngineOptions } from "../src/sync/engine";
import { memoryLocalStore, type LocalStore } from "../src/sync/local-store";
import { MAX_FUTURE_MS } from "../src/sync/clock";
import { Hub, type HubTransport } from "./support/hub";

const P = "p:Day 1/IMG_0042.CR3";
const ANA = "aaaaaaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbbbbbb";
const CY = "cccccccccccccccc";

const engines: Engine[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop()));
});

interface Member {
  engine: Engine;
  transport: () => HubTransport;
  store: LocalStore;
}

function member(
  room: Room,
  hub: Hub,
  id: string,
  extra: Partial<EngineOptions> & { store?: LocalStore } = {},
): Member {
  let made: HubTransport | null = null;
  const store = extra.store ?? memoryLocalStore();
  const engine = new Engine({
    room,
    memberId: id,
    name: () => (id === ANA ? "Ana" : id === BEN ? "Ben" : "Cy"),
    transport: (cursor) => (made = hub.transport(id, cursor)),
    store,
    flushMs: 0,
    ...extra,
  });
  engines.push(engine);
  return {
    engine,
    store,
    transport: () => {
      if (!made) throw new Error("not started");
      return made;
    },
  };
}

async function settle(...members: Member[]) {
  for (let i = 0; i < 3; i++) for (const m of members) await m.engine.idle();
}

describe("Engine", () => {
  it("carries a change from one member to the other", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const seen: unknown[] = [];
    const ana = member(room, hub, ANA);
    const ben = member(room, hub, BEN, { onApplied: (a) => void seen.push(...a) });
    await ana.engine.start();
    await ben.engine.start();
    ana.engine.record([[P, "rating", 4]]);
    await settle(ana, ben);
    expect(ben.engine.state.value(P, "rating")).toBe(4);
    expect(seen).toEqual([{ entity: P, field: "rating", value: 4 }]);
  });

  it("ends in one state whatever order and however often entries arrive", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const ana = member(room, hub, ANA);
    const ben = member(room, hub, BEN);
    await ana.engine.start();
    await ben.engine.start();
    hub.holding = true;
    ana.engine.record([[P, "rating", 2]]);
    await settle(ana);
    ben.engine.record([[P, "rating", 5], [P, "kw/cake", true]]);
    await settle(ben);
    ana.engine.record([[P, "kw/bride", true]]);
    await settle(ana);

    const late = member(room, hub, CY);
    hub.duplicate = true;
    hub.reverse = true;
    hub.release();
    await late.engine.start();
    await settle(ana, ben, late);
    expect(late.engine.state.toJSON().entities).toEqual(ana.engine.state.toJSON().entities);
    expect(ben.engine.state.toJSON().entities).toEqual(ana.engine.state.toJSON().entities);
    expect(late.engine.state.value(P, "rating")).toBe(5);
    expect(late.engine.state.fields(P, "kw/")).toEqual({ "kw/cake": true, "kw/bride": true });
  });

  it("rejects entries sealed for another room, and entries filed under another member", async () => {
    const room = await deriveRoom(makeRoomCode());
    const outsider = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const ben = member(room, hub, BEN);
    await ben.engine.start();
    const forged = { v: 1, kind: "ops", by: ANA, name: "Mallory", seq: 1, at: [1, ANA], ch: [[P, "rating", 1]], fp: {} };
    hub.entries.push({ data: await sealEntry(outsider, forged), origin: ANA });
    hub.entries.push({ data: await sealEntry(room, forged), origin: CY });
    hub.entries.push({ data: "garbage", origin: ANA });
    hub.deliverAll();
    await settle(ben);
    expect(ben.engine.state.value(P, "rating")).toBeUndefined();
    expect(ben.engine.view().rejected).toBe(3);
  });

  it("holds ops from a clock far ahead, names the member, and takes them once this clock catches up", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    let wall = 1_000_000;
    const ahead = 2 * 60 * 60_000;
    const ana = member(room, hub, ANA, { now: () => wall + ahead });
    const ben = member(room, hub, BEN, { now: () => wall });
    await ana.engine.start();
    await ben.engine.start();
    ana.engine.record([[P, "flag", "pick"]]);
    await settle(ana, ben);
    expect(ben.engine.state.value(P, "flag")).toBeUndefined();
    expect(ben.engine.view().held).toEqual([{ by: ANA, name: "Ana", aheadMs: expect.any(Number) }]);
    expect(ben.engine.view().held[0].aheadMs).toBeGreaterThan(MAX_FUTURE_MS);
    wall += ahead;
    ben.engine.tick();
    await settle(ben);
    expect(ben.engine.state.value(P, "flag")).toBe("pick");
    expect(ben.engine.view().held).toEqual([]);
  });

  it("keeps changes made offline and sends them when the medium is back", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const ana = member(room, hub, ANA);
    const ben = member(room, hub, BEN);
    await ana.engine.start();
    await ben.engine.start();
    ana.transport().online = false;
    ana.engine.record([[P, "label", "green"]]);
    await settle(ana);
    expect(ana.engine.view().unsent).toBe(1);
    expect(ben.engine.state.value(P, "label")).toBeUndefined();
    ana.transport().goOnline();
    await settle(ana, ben);
    expect(ben.engine.state.value(P, "label")).toBe("green");
    expect(ana.engine.view().unsent).toBe(0);
  });

  it("carries on its op numbers after a restart, and after losing its own record", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const store = memoryLocalStore();
    const first = member(room, hub, ANA, { store });
    await first.engine.start();
    first.engine.record([[P, "rating", 1]]);
    await settle(first);
    await first.engine.stop();
    engines.splice(engines.indexOf(first.engine), 1);

    const again = member(room, hub, ANA, { store });
    await again.engine.start();
    expect(again.engine.firstJoin).toBe(false);
    again.engine.record([[P, "rating", 2]]);
    await settle(again);
    await again.engine.stop();
    engines.splice(engines.indexOf(again.engine), 1);

    const forgetful = member(room, hub, ANA);
    await forgetful.engine.start();
    expect(forgetful.engine.firstJoin).toBe(true);
    forgetful.engine.record([[P, "rating", 3]]);
    await settle(forgetful);

    const ben = member(room, hub, BEN);
    await ben.engine.start();
    await settle(ben);
    expect(ben.engine.state.value(P, "rating")).toBe(3);
    expect(ben.engine.state.highest(ANA)).toBe(3);
  });

  it("publishes its whole state when the medium lost everything, so a newcomer still gets it", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const ana = member(room, hub, ANA);
    await ana.engine.start();
    ana.engine.record([[P, "rating", 4], ["c:sel", "name", "Selects"]]);
    await settle(ana);
    hub.wipe();
    await settle(ana);
    const ben = member(room, hub, BEN);
    await ben.engine.start();
    await settle(ana, ben);
    expect(ben.engine.state.value(P, "rating")).toBe(4);
    expect(ben.engine.state.value("c:sel", "name")).toBe("Selects");
  });

  it("shows who is where, and drops presence that went stale", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    let wall = 5_000_000;
    const ana = member(room, hub, ANA, { now: () => wall });
    const ben = member(room, hub, BEN, { now: () => wall });
    await ana.engine.start();
    await ben.engine.start();
    ana.engine.setPresence({ role: "editor", module: "develop", photo: P, editing: true });
    await new Promise((r) => setTimeout(r, 600));
    await settle(ana, ben);
    expect(ben.engine.view().members).toEqual([
      expect.objectContaining({ id: ANA, name: "Ana", role: "editor", photo: P, editing: true, fresh: true }),
    ]);
    wall += 10 * 60_000;
    expect(ben.engine.view().members[0].fresh).toBe(false);
  });
});
