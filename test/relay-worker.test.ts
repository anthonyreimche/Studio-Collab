// The Cloudflare relay's Durable Object, run against stand-ins for its storage
// and hibernating sockets: the same protocol as the Node relay, kept in
// Durable Object storage, surviving the object being evicted and rebuilt.

import { describe, expect, it } from "vitest";
import worker, { RelayRoom } from "../relay/cloudflare/worker.mjs";

const ROOM = "0123456789abcdef0123456789abcdef";
const TOKEN = "T".repeat(43);
const ANA = "aaaaaaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbbbbbb";

class FakeStorage {
  readonly data = new Map<string, unknown>();
  async get(key: string) {
    return structuredClone(this.data.get(key));
  }
  async put(keyOrBatch: string | Record<string, unknown>, value?: unknown) {
    if (typeof keyOrBatch === "string") this.data.set(keyOrBatch, structuredClone(value));
    else for (const [k, v] of Object.entries(keyOrBatch)) this.data.set(k, structuredClone(v));
  }
  async list({ prefix = "", start = "", limit = Infinity }: { prefix?: string; start?: string; limit?: number }) {
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix) && k >= start).sort().slice(0, limit);
    return new Map(keys.map((k) => [k, structuredClone(this.data.get(k))]));
  }
}

class FakeSocket {
  sent: { type: string; [key: string]: unknown }[] = [];
  attachment: unknown = null;
  closedWith: number | null = null;
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code: number) {
    this.closedWith = code;
  }
  serializeAttachment(value: unknown) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
}

function fakeObject(storage = new FakeStorage(), sockets: FakeSocket[] = []) {
  const ctx = {
    storage,
    acceptWebSocket: (s: FakeSocket) => void sockets.push(s),
    getWebSockets: () => sockets,
  };
  const upgraded: FakeSocket[] = [];
  const object = new RelayRoom(ctx, {}, {
    pair: () => [new FakeSocket(), new FakeSocket()],
    upgrade: (client: FakeSocket) => {
      upgraded.push(client);
      return new Response("upgraded");
    },
  });
  return { object, storage, sockets };
}

async function openSocket(object: RelayRoom, sockets: FakeSocket[], member: string, after = 0) {
  await object.fetch(new Request(`https://relay/v1/rooms/${ROOM}/socket`, { headers: { upgrade: "websocket" } }));
  const server = sockets[sockets.length - 1];
  await object.webSocketMessage(server, JSON.stringify({ type: "hello", token: TOKEN, after, member }));
  return server;
}

describe("Cloudflare relay", () => {
  it("relays pushes between sockets and keeps them in storage", async () => {
    const { object, storage, sockets } = fakeObject();
    const ana = await openSocket(object, sockets, ANA);
    const ben = await openSocket(object, sockets, BEN);
    await object.webSocketMessage(ana, JSON.stringify({ type: "push", ref: 1, entries: ["s1.a", "s1.b"] }));
    expect(ana.sent).toContainEqual({ type: "ack", ref: 1, seqs: [1, 2] });
    expect(ben.sent).toContainEqual({ type: "entries", entries: [{ seq: 1, data: "s1.a" }, { seq: 2, data: "s1.b" }], head: 2 });
    expect([...storage.data.keys()].sort()).toEqual(["e:000000000001", "e:000000000002", "meta"]);
  });

  it("passes presence to the others only", async () => {
    const { object, sockets } = fakeObject();
    const ana = await openSocket(object, sockets, ANA);
    const ben = await openSocket(object, sockets, BEN);
    await object.webSocketMessage(ana, JSON.stringify({ type: "presence", data: "s1.p" }));
    expect(ben.sent).toContainEqual({ type: "presence", member: ANA, data: "s1.p" });
    expect(ana.sent.filter((m) => m.type === "presence")).toEqual([]);
  });

  it("serves a member that returns after the object was evicted, from storage", async () => {
    const first = fakeObject();
    const ana = await openSocket(first.object, first.sockets, ANA);
    await first.object.webSocketMessage(ana, JSON.stringify({ type: "push", ref: 1, entries: ["s1.a", "s1.b", "s1.c"] }));
    const again = fakeObject(first.storage);
    const ben = await openSocket(again.object, again.sockets, BEN, 1);
    expect(ben.sent.find((m) => m.type === "entries")).toEqual({
      type: "entries",
      entries: [{ seq: 2, data: "s1.b" }, { seq: 3, data: "s1.c" }],
      head: 3,
    });
  });

  it("closes a socket with the wrong token", async () => {
    const { object, sockets } = fakeObject();
    await openSocket(object, sockets, ANA);
    await object.fetch(new Request(`https://relay/v1/rooms/${ROOM}/socket`, { headers: { upgrade: "websocket" } }));
    const mallory = sockets[sockets.length - 1];
    await object.webSocketMessage(mallory, JSON.stringify({ type: "hello", token: "U".repeat(43), after: 0, member: BEN }));
    expect(mallory.sent).toContainEqual(expect.objectContaining({ type: "error", code: "auth" }));
    expect(mallory.closedWith).toBe(1008);
  });

  it("answers HTTPS pushes and polls, and tells the room's sockets", async () => {
    const { object, sockets } = fakeObject();
    const ana = await openSocket(object, sockets, ANA);
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const pushed = await object.fetch(
      new Request(`https://relay/v1/rooms/${ROOM}/entries`, { method: "POST", headers, body: JSON.stringify({ entries: ["s1.http"] }) }),
    );
    expect(await pushed.json()).toEqual({ seqs: [1], head: 1 });
    expect(ana.sent).toContainEqual({ type: "entries", entries: [{ seq: 1, data: "s1.http" }], head: 1 });
    const page = await (await object.fetch(new Request(`https://relay/v1/rooms/${ROOM}/entries?after=0`, { headers }))).json();
    expect(page.entries).toEqual([{ seq: 1, data: "s1.http" }]);
  });

  it("routes a room to its object, and refuses rooms a locked relay doesn't serve", async () => {
    const asked: string[] = [];
    const env = {
      ALLOWED_ROOMS: ROOM,
      ROOMS: {
        idFromName: (name: string) => name,
        get: (id: string) => ({ fetch: async () => (asked.push(id), new Response("from object")) }),
      },
    };
    expect(await (await worker.fetch(new Request(`https://relay/v1/rooms/${ROOM}/entries`), env)).text()).toBe("from object");
    expect(asked).toEqual([ROOM]);
    expect((await worker.fetch(new Request(`https://relay/v1/rooms/${"f".repeat(32)}/entries`), env)).status).toBe(403);
    expect(await (await worker.fetch(new Request("https://relay/v1/health"), env)).json()).toEqual({ ok: true, protocol: 1 });
  });
});
