// Catalogue to room and back, between members with their own catalogues:
// metadata, keywords, edits merged per parameter, edits held while a photo is
// open, joining a room, offline changes, relinking, stages and echo.

import { afterEach, describe, expect, it } from "vitest";
import { deriveRoom, makeRoomCode, type Room } from "../src/crypto/room";
import { CatalogSync, photoKey } from "../src/sync/catalog-sync";
import { Engine } from "../src/sync/engine";
import { memoryLocalStore, type LocalStore } from "../src/sync/local-store";
import { fakeCatalog, photo, type FakeCatalog } from "./support/fake-catalog";
import { Hub, type HubTransport } from "./support/hub";

const ANA = "aaaaaaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbbbbbb";

interface Member {
  engine: Engine;
  sync: CatalogSync;
  catalog: FakeCatalog;
  transport(): HubTransport;
}

const running: Member[] = [];
afterEach(async () => {
  for (const m of running.splice(0)) {
    m.sync.stop();
    await m.engine.stop();
  }
});

async function join(
  room: Room,
  hub: Hub,
  id: string,
  catalog: FakeCatalog,
  opts: { store?: LocalStore; autoStage?: boolean } = {},
): Promise<Member> {
  let made: HubTransport | null = null;
  let sync: CatalogSync | null = null;
  const engine = new Engine({
    room,
    memberId: id,
    name: () => (id === ANA ? "Ana" : "Ben"),
    transport: (cursor) => (made = hub.transport(id, cursor)),
    store: opts.store ?? memoryLocalStore(),
    flushMs: 0,
    onApplied: (applied) => sync?.applied(applied),
    onLoaded: () => sync?.recordOfflineChanges(),
  });
  sync = new CatalogSync({
    catalog,
    engine,
    stepLabel: () => `Studio Collab: ${id === ANA ? "Ben" : "Ana"}`,
    autoStage: () => opts.autoStage ?? false,
    settleMs: 0,
  });
  await engine.start();
  await sync.begin();
  const m: Member = {
    engine,
    sync,
    catalog,
    transport: () => {
      if (!made) throw new Error("not started");
      return made;
    },
  };
  running.push(m);
  return m;
}

async function settle(...members: Member[]) {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 5));
    for (const m of members) {
      m.sync.settle();
      await m.engine.idle();
    }
  }
}

const shoot = () => [photo("1", "Day 1/IMG_0001.CR3"), photo("2", "Day 1/IMG_0002.CR3")];

describe("CatalogSync", () => {
  it("carries ratings, flags and labels to the other catalogue", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const ana = await join(room, hub, ANA, fakeCatalog(shoot()));
    const ben = await join(room, hub, BEN, fakeCatalog(shoot()));
    ana.catalog.change("1", { rating: 4, flag: "pick", colorLabel: "red" });
    await settle(ana, ben);
    expect(ben.catalog.get("1")).toMatchObject({ rating: 4, flag: "pick", colorLabel: "red" });
  });

  it("doesn't send a value back that it was just given", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const ana = await join(room, hub, ANA, fakeCatalog(shoot()));
    const ben = await join(room, hub, BEN, fakeCatalog(shoot()));
    ana.catalog.change("1", { rating: 3 });
    await settle(ana, ben);
    expect(ben.catalog.get("1").rating).toBe(3);
    expect(ben.transport().published).toBe(0);
  });

  it("doesn't send back a remote value still being written to the catalogue", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const ana = await join(room, hub, ANA, fakeCatalog(shoot()));
    const slow = fakeCatalog(shoot());
    const setRating = slow.setRating;
    slow.setRating = async (id, rating) => {
      slow.change(id, {});
      ben.sync.settle();
      await new Promise((r) => setTimeout(r, 30));
      await setRating(id, rating);
    };
    const ben = await join(room, hub, BEN, slow);
    ana.catalog.change("1", { rating: 4 });
    await settle(ana, ben);
    await new Promise((r) => setTimeout(r, 60));
    await settle(ana, ben);
    expect(ben.catalog.get("1").rating).toBe(4);
    expect(ana.catalog.get("1").rating).toBe(4);
    expect(ben.transport().published).toBe(0);
  });

  it("keeps keywords two people add at once, and removes one taken off", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const ana = await join(room, hub, ANA, fakeCatalog(shoot()));
    const ben = await join(room, hub, BEN, fakeCatalog(shoot()));
    hub.holding = true;
    ana.catalog.change("1", { keywords: ["bride"] });
    ben.catalog.change("1", { keywords: ["cake"] });
    await settle(ana, ben);
    hub.release();
    await settle(ana, ben);
    expect(new Set(ana.catalog.get("1").keywords)).toEqual(new Set(["bride", "cake"]));
    expect(new Set(ben.catalog.get("1").keywords)).toEqual(new Set(["bride", "cake"]));
    ben.catalog.change("1", { keywords: ["cake"] });
    await settle(ana, ben);
    expect(ana.catalog.get("1").keywords).toEqual(["cake"]);
  });

  it("merges develop edits per parameter and lands them as one history step", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const ana = await join(room, hub, ANA, fakeCatalog(shoot()));
    const ben = await join(room, hub, BEN, fakeCatalog(shoot()));
    ana.catalog.edit("1", { exposure: 0.5 });
    await ana.sync.recordEdit("1");
    await settle(ana, ben);
    expect(ben.catalog.current("1")?.params.exposure).toBe(0.5);

    hub.holding = true;
    ana.catalog.edit("1", { exposure: 0.7 });
    await ana.sync.recordEdit("1");
    ben.catalog.edit("1", { temperature: 4800 }, { "warmth.amount": 0.2 });
    await ben.sync.recordEdit("1");
    await settle(ana, ben);
    hub.release();
    await settle(ana, ben);
    for (const m of [ana, ben]) {
      expect(m.catalog.current("1")?.params).toMatchObject({ exposure: 0.7, temperature: 4800 });
      expect(m.catalog.current("1")?.paramBag).toEqual({ "warmth.amount": 0.2 });
    }
    expect(ana.catalog.current("1")?.label).toBe("Studio Collab: Ben");
    expect(ana.catalog.edits.get("1")?.stack.length).toBe(3);
  });

  it("holds a remote edit while the photo is open in Develop, then applies it", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const ana = await join(room, hub, ANA, fakeCatalog(shoot()));
    const ben = await join(room, hub, BEN, fakeCatalog(shoot()));
    ben.catalog.editing = "1";
    ana.catalog.edit("1", { exposure: 1 });
    await ana.sync.recordEdit("1");
    await settle(ana, ben);
    expect(ben.catalog.current("1")).toBeUndefined();
    expect([...ben.sync.deferred]).toEqual(["1"]);
    ben.catalog.editing = null;
    ben.sync.flushDeferred();
    await settle(ben);
    expect(ben.catalog.current("1")?.params.exposure).toBe(1);
    expect(ben.sync.deferred.size).toBe(0);
  });

  it("on a first join, takes the room's values and sends only what the room hasn't got", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const ana = await join(room, hub, ANA, fakeCatalog(shoot()));
    ana.catalog.change("1", { rating: 5 });
    await settle(ana);
    const late = fakeCatalog([
      photo("1", "Day 1/IMG_0001.CR3", { rating: 1 }),
      photo("2", "Day 1/IMG_0002.CR3", { colorLabel: "blue" }),
    ]);
    const ben = await join(room, hub, BEN, late);
    await settle(ana, ben);
    expect(ben.catalog.get("1").rating).toBe(5);
    expect(ana.catalog.get("2").colorLabel).toBe("blue");
    expect(ana.catalog.get("1").rating).toBe(5);
  });

  it("sends changes made while it wasn't running, judged against the state it kept", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const store = memoryLocalStore();
    const benCatalog = fakeCatalog(shoot());
    const ana = await join(room, hub, ANA, fakeCatalog(shoot()));
    const ben = await join(room, hub, BEN, benCatalog, { store });
    ana.catalog.change("1", { rating: 2 });
    await settle(ana, ben);
    ben.sync.stop();
    await ben.engine.stop();
    running.splice(running.indexOf(ben), 1);

    benCatalog.change("1", { rating: 4 });
    const again = await join(room, hub, BEN, benCatalog, { store });
    await settle(ana, again);
    expect(ana.catalog.get("1").rating).toBe(4);
    expect(again.catalog.get("1").rating).toBe(4);
  });

  it("finds a photo by its fingerprint where the other member opened the tree a level up", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const atShoot = photo("a", "Wedding/Day 1/IMG_0001.CR3", { filename: "IMG_0001.CR3", fileSize: 31_457_280 });
    const atDay = photo("b", "Day 1/IMG_0001.CR3", { filename: "IMG_0001.CR3", fileSize: 31_457_280 });
    atDay.exif = atShoot.exif;
    const ana = await join(room, hub, ANA, fakeCatalog([atShoot]));
    const ben = await join(room, hub, BEN, fakeCatalog([atDay]));
    ana.catalog.change("a", { flag: "pick" });
    await settle(ana, ben);
    expect(ben.catalog.get("b").flag).toBe("pick");
  });

  it("moves a photo's stage along as it is culled, edited and exported", async () => {
    const room = await deriveRoom(makeRoomCode());
    const hub = new Hub();
    const ana = await join(room, hub, ANA, fakeCatalog(shoot()), { autoStage: true });
    const ben = await join(room, hub, BEN, fakeCatalog(shoot()), { autoStage: true });
    expect(ben.sync.stageOf("1")).toBe("shot");
    ana.catalog.change("1", { rating: 3 });
    await settle(ana, ben);
    expect(ben.sync.stageOf("1")).toBe("culled");
    ana.catalog.edit("1", { exposure: 0.3 });
    await ana.sync.recordEdit("1");
    await settle(ana, ben);
    expect(ben.sync.stageOf("1")).toBe("edited");
    ben.sync.markExported("1");
    await settle(ana, ben);
    expect(ana.sync.stageOf("1")).toBe("exported");
    ana.catalog.change("1", { rating: 4 });
    await settle(ana, ben);
    expect(ben.sync.stageOf("1")).toBe("exported");
  });

  it("keys a virtual copy apart from its master", () => {
    expect(photoKey({ relPath: "Day 1/IMG_1.CR3" })).toBe("p:Day 1/IMG_1.CR3");
    expect(photoKey({ relPath: "Day 1/IMG_1.CR3", copyOf: "m", copyName: "copy 2" })).toBe("p:Day 1/IMG_1.CR3#copy:copy 2");
    expect(photoKey({ relPath: "Day 1\\IMG_1.CR3" })).toBe("p:Day 1/IMG_1.CR3");
  });
});
