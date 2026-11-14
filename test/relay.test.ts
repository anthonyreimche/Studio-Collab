// The relay: the room module both servers share, then the Node server run
// for real on a local port, over HTTPS-style requests and over WebSockets.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayServer } from "../relay/node/server.mjs";
import { LIMITS, Room, memoryStore } from "../relay/shared/room.mjs";

const ROOM = "0123456789abcdef0123456789abcdef";
const TOKEN = "T".repeat(43);
const OTHER_TOKEN = "U".repeat(43);
const ANA = "aaaaaaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbbbbbb";

describe("Room", () => {
  it("binds the first token it is asked with and refuses any other", async () => {
    const room = new Room(memoryStore());
    expect(await room.authorize(TOKEN)).toBe(true);
    expect(await room.authorize(TOKEN)).toBe(true);
    expect(await room.authorize(OTHER_TOKEN)).toBe(false);
    expect(await room.authorize("short")).toBe(false);
  });

  it("keeps only the token's hash", async () => {
    const store = memoryStore();
    await new Room(store).authorize(TOKEN);
    expect(JSON.stringify(await store.load())).not.toContain(TOKEN);
  });

  it("numbers entries in arrival order and hands them out a page at a time", async () => {
    const room = new Room(memoryStore());
    expect((await room.push(["s1.a", "s1.b"])).seqs).toEqual([1, 2]);
    expect((await room.push(["s1.c"])).seqs).toEqual([3]);
    expect(await room.since(1)).toEqual({ entries: [{ seq: 2, data: "s1.b" }, { seq: 3, data: "s1.c" }], head: 3, more: false });
    expect((await room.since(0, 2)).more).toBe(true);
    expect((await room.since(3)).entries).toEqual([]);
  });

  it("refuses entries that are empty, multi-line, too big, or would overfill the room", async () => {
    const room = new Room(memoryStore());
    expect(await room.push([])).toEqual({ error: "bad-request" });
    expect(await room.push(["a\nb"])).toEqual({ error: "bad-request" });
    expect(await room.push(["x".repeat(LIMITS.entryBytes + 1)])).toEqual({ error: "too-large" });
    const saved = LIMITS.roomEntries;
    LIMITS.roomEntries = 2;
    try {
      expect((await room.push(["s1.a", "s1.b"])).seqs).toEqual([1, 2]);
      expect(await room.push(["s1.c"])).toEqual({ error: "room-full" });
    } finally {
      LIMITS.roomEntries = saved;
    }
  });

  it("wakes a waiting reader when an entry arrives, and lets it go at the timeout", async () => {
    const room = new Room(memoryStore());
    const waiting = room.waitSince(0, 5000);
    await room.push(["s1.now"]);
    expect((await waiting).entries).toEqual([{ seq: 1, data: "s1.now" }]);
    const started = Date.now();
    expect((await room.waitSince(1, 50)).entries).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it("forgets presence after 90 seconds", async () => {
    let now = 1000;
    const room = new Room(memoryStore(), () => now);
    room.setPresence(ANA, "s1.p");
    expect(room.presenceList()).toEqual([{ member: ANA, data: "s1.p", age: 0 }]);
    now += LIMITS.presenceMs + 1;
    expect(room.presenceList()).toEqual([]);
    expect(room.setPresence("not-a-member", "s1.p")).toBe(false);
  });
});

type Relay = ReturnType<typeof createRelayServer>;
const running: Relay[] = [];
const temp: string[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.close()));
  for (const d of temp.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function startRelay(opts: Parameters<typeof createRelayServer>[0] = {}) {
  const relay = createRelayServer(opts);
  running.push(relay);
  const port = await relay.listen(0, "127.0.0.1");
  return { relay, http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}

const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

interface Client {
  socket: WebSocket;
  messages: { type: string; [key: string]: unknown }[];
  next(type: string): Promise<{ type: string; [key: string]: unknown }>;
  send(message: object): void;
  closed: Promise<void>;
}

function connect(base: string, room = ROOM): Promise<Client> {
  const socket = new WebSocket(`${base}/v1/rooms/${room}/socket`);
  const messages: Client["messages"] = [];
  const waiting: { type: string; resolve: (m: Client["messages"][number]) => void; from: number }[] = [];
  let read = 0;
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()));
  socket.addEventListener("message", (event) => {
    messages.push(JSON.parse(String(event.data)));
    for (const w of [...waiting]) {
      const found = messages.slice(w.from).find((m) => m.type === w.type);
      if (found) {
        waiting.splice(waiting.indexOf(w), 1);
        w.resolve(found);
      }
    }
  });
  const client: Client = {
    socket,
    messages,
    closed,
    send: (message) => socket.send(JSON.stringify(message)),
    next(type) {
      const from = read;
      const found = messages.slice(from).findIndex((m) => m.type === type);
      if (found !== -1) {
        read = from + found + 1;
        return Promise.resolve(messages[from + found]);
      }
      return new Promise((resolve) =>
        waiting.push({
          type,
          from,
          resolve: (m) => {
            read = messages.indexOf(m) + 1;
            resolve(m);
          },
        }),
      );
    },
  };
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(client));
    socket.addEventListener("error", () => reject(new Error("couldn't connect")));
  });
}

describe("Node relay over HTTP", () => {
  it("answers its health check", async () => {
    const { http } = await startRelay();
    expect(await (await fetch(`${http}/v1/health`)).json()).toEqual({ ok: true, protocol: 1 });
  });

  it("takes entries and hands them back from a number on", async () => {
    const { http } = await startRelay();
    const pushed = await fetch(`${http}/v1/rooms/${ROOM}/entries`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ entries: ["s1.a", "s1.b"] }),
    });
    expect(await pushed.json()).toEqual({ seqs: [1, 2], head: 2 });
    const page = await (await fetch(`${http}/v1/rooms/${ROOM}/entries?after=1`, { headers: auth() })).json();
    expect(page).toMatchObject({ head: 2, more: false, entries: [{ seq: 2, data: "s1.b" }], presence: [] });
  });

  it("refuses a wrong token, and rooms a locked relay doesn't serve", async () => {
    const { http } = await startRelay({ allowedRooms: ROOM });
    await fetch(`${http}/v1/rooms/${ROOM}/entries`, { headers: auth() });
    const wrong = await fetch(`${http}/v1/rooms/${ROOM}/entries`, { headers: auth(OTHER_TOKEN) });
    expect(wrong.status).toBe(401);
    const other = await fetch(`${http}/v1/rooms/${"f".repeat(32)}/entries`, { headers: auth() });
    expect(other.status).toBe(403);
  });

  it("holds a long poll open until an entry arrives", async () => {
    const { http } = await startRelay();
    await fetch(`${http}/v1/rooms/${ROOM}/entries`, { headers: auth() });
    const poll = fetch(`${http}/v1/rooms/${ROOM}/entries?after=0&wait=5`, { headers: auth() }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`${http}/v1/rooms/${ROOM}/entries`, { method: "POST", headers: auth(), body: JSON.stringify({ entries: ["s1.late"] }) });
    expect((await poll).entries).toEqual([{ seq: 1, data: "s1.late" }]);
  });

  it("passes presence along with the entries", async () => {
    const { http } = await startRelay();
    await fetch(`${http}/v1/rooms/${ROOM}/presence`, { method: "POST", headers: auth(), body: JSON.stringify({ member: ANA, data: "s1.p" }) });
    const page = await (await fetch(`${http}/v1/rooms/${ROOM}/entries`, { headers: auth() })).json();
    expect(page.presence).toEqual([expect.objectContaining({ member: ANA, data: "s1.p" })]);
  });
});

describe("Node relay over WebSockets", () => {
  it("relays entries and presence between members, and acknowledges pushes", async () => {
    const { ws } = await startRelay();
    const ana = await connect(ws);
    const ben = await connect(ws);
    ana.send({ type: "hello", token: TOKEN, after: 0, member: ANA });
    ben.send({ type: "hello", token: TOKEN, after: 0, member: BEN });
    await ana.next("welcome");
    await ben.next("welcome");
    ana.send({ type: "push", ref: 7, entries: ["s1.one"] });
    expect(await ana.next("ack")).toEqual({ type: "ack", ref: 7, seqs: [1] });
    expect(await ben.next("entries")).toEqual({ type: "entries", entries: [{ seq: 1, data: "s1.one" }], head: 1 });
    ana.send({ type: "presence", data: "s1.here" });
    expect(await ben.next("presence")).toEqual({ type: "presence", member: ANA, data: "s1.here" });
    expect(ana.messages.some((m) => m.type === "presence")).toBe(false);
  });

  it("sends a returning member only what it hasn't had", async () => {
    const { ws, http } = await startRelay();
    await fetch(`${http}/v1/rooms/${ROOM}/entries`, { method: "POST", headers: auth(), body: JSON.stringify({ entries: ["s1.a", "s1.b", "s1.c"] }) });
    const ben = await connect(ws);
    ben.send({ type: "hello", token: TOKEN, after: 2, member: BEN });
    expect(await ben.next("welcome")).toMatchObject({ head: 3, protocol: 1 });
    expect(await ben.next("entries")).toEqual({ type: "entries", entries: [{ seq: 3, data: "s1.c" }], head: 3 });
  });

  it("tells a member whose place is past the relay's end that the relay lost its entries", async () => {
    const { ws } = await startRelay();
    const ben = await connect(ws);
    ben.send({ type: "hello", token: TOKEN, after: 40, member: BEN });
    await ben.next("welcome");
    expect(await ben.next("reset")).toEqual({ type: "reset", head: 0 });
  });

  it("closes a socket that brings the wrong token", async () => {
    const { ws } = await startRelay();
    const ana = await connect(ws);
    ana.send({ type: "hello", token: TOKEN, after: 0, member: ANA });
    await ana.next("welcome");
    const mallory = await connect(ws);
    mallory.send({ type: "hello", token: OTHER_TOKEN, after: 0, member: BEN });
    expect(await mallory.next("error")).toMatchObject({ code: "auth" });
    await mallory.closed;
  });

  it("refuses anything before hello", async () => {
    const { ws } = await startRelay();
    const c = await connect(ws);
    c.send({ type: "push", ref: 1, entries: ["s1.x"] });
    expect(await c.next("error")).toMatchObject({ code: "auth" });
    await c.closed;
  });

  it("keeps rooms across a restart when given a data folder", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "studio-collab-relay-"));
    temp.push(dataDir);
    const first = await startRelay({ dataDir });
    await fetch(`${first.http}/v1/rooms/${ROOM}/entries`, { method: "POST", headers: auth(), body: JSON.stringify({ entries: ["s1.kept"] }) });
    await first.relay.close();
    const second = await startRelay({ dataDir });
    const page = await (await fetch(`${second.http}/v1/rooms/${ROOM}/entries`, { headers: auth() })).json();
    expect(page.entries).toEqual([{ seq: 1, data: "s1.kept" }]);
    expect((await fetch(`${second.http}/v1/rooms/${ROOM}/entries`, { headers: auth(OTHER_TOKEN) })).status).toBe(401);
  });
});
