// The durable transports double as signalling paths: the shared folder (the
// slow last resort) and the relay's socket (passed on, never stored).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayServer } from "../relay/node/server.mjs";
import { FolderTransport } from "../src/transport/folder";
import { RelayTransport } from "../src/transport/relay";
import type { TransportSink } from "../src/transport/types";
import { nodeFolder } from "./support/node-folder";

const ROOM = "0123456789abcdef0123456789abcdef";
const ANA = "aaaaaaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbbbbbb";
const TOKEN = "T".repeat(43);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function listener() {
  const signals: { data: string; origin?: string }[] = [];
  const sink: TransportSink = {
    entries: () => {},
    presence: () => {},
    status: () => {},
    signal: (data, origin) => void signals.push({ data, origin }),
  };
  return { signals, sink };
}

async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("signals through the shared folder", () => {
  it("are read by the others once each, and only the latest few are kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "studio-collab-signal-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ana = new FolderTransport({ root: nodeFolder(dir), roomId: ROOM, memberId: ANA, pollMs: 0 });
    const ben = new FolderTransport({ root: nodeFolder(dir), roomId: ROOM, memberId: BEN, pollMs: 0 });
    const heard = listener();
    await ana.start(listener().sink);
    await ben.start(heard.sink);
    for (let i = 1; i <= 12; i++) await ana.publishSignal(`s1.signal-${i}`);
    await ben.poll();
    await ben.poll();
    expect(heard.signals.map((s) => s.data)).toEqual(Array.from({ length: 8 }, (_, i) => `s1.signal-${i + 5}`));
    expect(heard.signals.every((s) => s.origin === ANA)).toBe(true);
  });
});

describe("signals through the relay's socket", () => {
  it("reach the room's other sockets and are never stored", async () => {
    const relay = createRelayServer();
    cleanups.push(() => relay.close());
    const port = await relay.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const make = (member: string) => {
      let cursor = 0;
      const t = new RelayTransport({
        baseUrl: base,
        roomId: ROOM,
        token: TOKEN,
        memberId: member,
        mode: "socket",
        fetch: (url, init) => fetch(url, init),
        openSocket: (url) => new WebSocket(url),
        cursor: { get: () => cursor, set: (n) => void (cursor = n) },
      });
      cleanups.push(() => t.stop());
      return t;
    };
    const ana = make(ANA);
    const ben = make(BEN);
    const heardByBen = listener();
    const heardByAna = listener();
    await ana.start(heardByAna.sink);
    await ben.start(heardByBen.sink);
    await ana.publishSignal("s1.offer");
    await until(() => heardByBen.signals.length === 1);
    expect(heardByBen.signals).toEqual([{ data: "s1.offer", origin: ANA }]);
    expect(heardByAna.signals).toEqual([]);
    const page = await (await fetch(`${base}/v1/rooms/${ROOM}/entries`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(page.head).toBe(0);
  });
});
