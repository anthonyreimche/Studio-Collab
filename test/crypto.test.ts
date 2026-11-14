// The room code and what derives from it: the room id, the seal key and the
// relay token. Sealed entries open only with the room's own key and only in
// that room; anything else is rejected, never thrown.

import { describe, expect, it } from "vitest";
import { deriveRoom, makeRoomCode, openEntry, parseRoomCode, sealEntry } from "../src/crypto/room";
import { readPayload } from "../src/sync/payload";

const OP = {
  v: 1,
  kind: "ops",
  by: "a1b2c3d4e5f60718",
  name: "Ana",
  seq: 1,
  at: [1000, "a1b2c3d4e5f60718"],
  ch: [["p:IMG_1.CR3", "rating", 4]],
  fp: {},
};

describe("room code", () => {
  it("is slc1- and 43 base64url characters, and reads back", () => {
    const code = makeRoomCode();
    expect(code).toMatch(/^slc1-[A-Za-z0-9_-]{43}$/);
    expect(parseRoomCode(`  ${code}\n`)).toBe(code);
  });

  it("refuses anything else", () => {
    expect(parseRoomCode("slc1-short")).toBeNull();
    expect(parseRoomCode("hello")).toBeNull();
    expect(parseRoomCode(`slc2-${"A".repeat(43)}`)).toBeNull();
  });

  it("derives the same room on every computer, and different rooms from different codes", async () => {
    const code = makeRoomCode();
    const a = await deriveRoom(code);
    const b = await deriveRoom(code);
    const other = await deriveRoom(makeRoomCode());
    expect(a.roomId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.roomId).toBe(b.roomId);
    expect(a.relayToken).toBe(b.relayToken);
    expect(a.relayToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(other.roomId).not.toBe(a.roomId);
    expect(a.relayToken).not.toContain(code.slice(5, 20));
  });
});

describe("sealed entries", () => {
  it("open with the room's key to what was sealed", async () => {
    const room = await deriveRoom(makeRoomCode());
    const sealed = await sealEntry(room, OP);
    expect(sealed).toMatch(/^s1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("Ana");
    expect(await openEntry(room, sealed)).toEqual(OP);
  });

  it("never seal the same op to the same text twice", async () => {
    const room = await deriveRoom(makeRoomCode());
    expect(await sealEntry(room, OP)).not.toBe(await sealEntry(room, OP));
  });

  it("are rejected under another room's code", async () => {
    const room = await deriveRoom(makeRoomCode());
    const outsider = await deriveRoom(makeRoomCode());
    expect(await openEntry(outsider, await sealEntry(room, OP))).toBeNull();
  });

  it("are rejected when a single character is changed", async () => {
    const room = await deriveRoom(makeRoomCode());
    const sealed = await sealEntry(room, OP);
    const at = sealed.length - 5;
    const flipped = sealed.slice(0, at) + (sealed[at] === "A" ? "B" : "A") + sealed.slice(at + 1);
    expect(await openEntry(room, flipped)).toBeNull();
  });

  it("are rejected in another room even with the same key", async () => {
    const room = await deriveRoom(makeRoomCode());
    const moved = { ...room, roomId: "0".repeat(32) };
    expect(await openEntry(moved, await sealEntry(room, OP))).toBeNull();
  });

  it("reject garbage of every shape without throwing", async () => {
    const room = await deriveRoom(makeRoomCode());
    for (const junk of ["", "s1.", "s1..", "s1.@@.@@", "x".repeat(10), "s1.AAAA.AAAA", "s2.AAAA.AAAA"])
      expect(await openEntry(room, junk)).toBeNull();
  });
});

describe("readPayload", () => {
  it("takes a well-formed op", () => {
    expect(readPayload(OP)).toEqual(OP);
  });

  it("refuses ops with a bad stamp, a stamp by someone else, a bad change or a bad sequence number", () => {
    expect(readPayload({ ...OP, at: [1000] })).toBeNull();
    expect(readPayload({ ...OP, at: [1000, "someone-else"] })).toBeNull();
    expect(readPayload({ ...OP, ch: [["p:x", 3, 1]] })).toBeNull();
    expect(readPayload({ ...OP, ch: [["q:x", "rating", 1]] })).toBeNull();
    expect(readPayload({ ...OP, seq: 0 })).toBeNull();
    expect(readPayload({ ...OP, seq: 1.5 })).toBeNull();
    expect(readPayload({ ...OP, by: "" })).toBeNull();
    expect(readPayload({ ...OP, v: 2 })).toBeNull();
    expect(readPayload(null)).toBeNull();
  });

  it("takes presence, and drops a role it doesn't know", () => {
    const presence = {
      v: 1,
      kind: "presence",
      by: "m1",
      name: "Ben",
      role: "editor",
      module: "develop",
      photo: "p:IMG_2.NEF",
      editing: true,
      wall: 123,
      app: "1.0.0",
    };
    expect(readPayload(presence)).toEqual(presence);
    expect(readPayload({ ...presence, role: "boss" })).toEqual({ ...presence, role: "" });
  });
});
