// Team collections and settings read back from whatever was stored.

import { afterEach, describe, expect, it } from "vitest";
import { deriveRoom, makeRoomCode } from "../src/crypto/room";
import { readProfile, readRoom, relayAddress, memberIdFor, socketOrigin, type SettingsStore } from "../src/settings";
import { CatalogSync } from "../src/sync/catalog-sync";
import { createCollection, deleteCollection, inCollection, listCollections, renameCollection, setMembership } from "../src/sync/collections";
import { Engine } from "../src/sync/engine";
import { memoryLocalStore } from "../src/sync/local-store";
import { fakeCatalog, photo } from "./support/fake-catalog";
import { Hub } from "./support/hub";

const stopping: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stopping.splice(0)) await stop();
});

async function solo() {
  const room = await deriveRoom(makeRoomCode());
  const hub = new Hub();
  const catalog = fakeCatalog([photo("1", "a/1.CR3"), photo("2", "a/2.CR3"), photo("3", "a/3.CR3")]);
  let sync: CatalogSync | null = null;
  const engine = new Engine({
    room,
    memberId: "aaaaaaaaaaaaaaaa",
    name: () => "Ana",
    transport: (cursor) => hub.transport("aaaaaaaaaaaaaaaa", cursor),
    store: memoryLocalStore(),
    flushMs: 0,
    onApplied: (a) => sync?.applied(a),
  });
  sync = new CatalogSync({ catalog, engine, stepLabel: () => "", autoStage: () => false, settleMs: 0 });
  await engine.start();
  await sync.begin();
  stopping.push(async () => {
    sync?.stop();
    await engine.stop();
  });
  return { engine, sync };
}

describe("team collections", () => {
  it("are made, filled, counted, renamed and deleted", async () => {
    const { engine, sync } = await solo();
    const id = createCollection(engine, "  Selects ");
    setMembership(sync, engine, ["1", "2"], id, true);
    await engine.idle();
    expect(listCollections(engine.state)).toEqual([{ id, name: "Selects", count: 2 }]);
    expect(inCollection(sync, "1", id)).toBe(true);
    expect(inCollection(sync, "3", id)).toBe(false);
    setMembership(sync, engine, ["2"], id, false);
    renameCollection(engine, id, "Client picks");
    await engine.idle();
    expect(listCollections(engine.state)).toEqual([{ id, name: "Client picks", count: 1 }]);
    deleteCollection(engine, id);
    await engine.idle();
    expect(listCollections(engine.state)).toEqual([]);
  });
});

function settingsOf(values: Record<string, unknown>): SettingsStore & { values: Record<string, unknown> } {
  return {
    values,
    get: <T,>(key: string, fallback: T): T => (key in values ? (values[key] as T) : fallback),
    set: (key, value) => void (values[key] = value),
  };
}

describe("settings", () => {
  it("read a profile and drop a role they don't know", () => {
    expect(readProfile(settingsOf({ profile: { name: "Ana", role: "editor" } }))).toEqual({ name: "Ana", role: "editor" });
    expect(readProfile(settingsOf({ profile: { name: 3, role: "boss" } }))).toEqual({ name: "", role: "" });
  });

  it("read a room only when its code and its way of reaching it are whole", () => {
    const code = makeRoomCode();
    expect(readRoom(settingsOf({ room: { code, transport: "folder", folderToken: "t", folderLabel: "Drive", project: "p" } }))).toEqual({
      code,
      keychain: false,
      transport: "folder",
      folderToken: "t",
      folderLabel: "Drive",
      project: "p",
    });
    expect(readRoom(settingsOf({ room: { keychain: true, transport: "folder", folderToken: "t", project: "p" } }))).toMatchObject({
      code: "",
      keychain: true,
    });
    expect(readRoom(settingsOf({ room: { code, transport: "relay", relayUrl: "http://lan:8787", project: "" } }))).toBeNull();
    expect(readRoom(settingsOf({ room: { code: "nope", transport: "folder", folderToken: "t" } }))).toBeNull();
  });

  it("take only an https relay address, and give its wss origin", () => {
    expect(relayAddress(" https://relay.studio.example/collab/ ")).toBe("https://relay.studio.example/collab");
    expect(relayAddress("https://relay.studio.example")).toBe("https://relay.studio.example");
    expect(relayAddress("http://relay.studio.example")).toBeNull();
    expect(relayAddress("https://user:pw@relay.studio.example")).toBeNull();
    expect(relayAddress("wss://relay.studio.example")).toBeNull();
    expect(socketOrigin("https://relay.studio.example:8443/collab")).toBe("wss://relay.studio.example:8443");
  });

  it("make one member id per room and keep it", () => {
    const settings = settingsOf({});
    const a = memberIdFor(settings, "room-a");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(memberIdFor(settings, "room-a")).toBe(a);
    expect(memberIdFor(settings, "room-b")).not.toBe(a);
  });
});
