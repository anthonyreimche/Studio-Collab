// The relay transport, the extension's side of the relay, against the Node
// relay running on a local port: over a socket, over long-polled requests,
// through a relay restart, and after a relay that lost its entries.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayServer } from "../relay/node/server.mjs";
import { RelayTransport, type RelayTransportOptions } from "../src/transport/relay";
import type { TransportSink, TransportStatus } from "../src/transport/types";

const ROOM = "0123456789abcdef0123456789abcdef";
const TOKEN = "T".repeat(43);
const ANA = "aaaaaaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbbbbbb";

const relays: ReturnType<typeof createRelayServer>[] = [];
const transports: RelayTransport[] = [];
const temp: string[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.stop()));
  await Promise.all(relays.splice(0).map((r) => r.close()));
  for (const d of temp.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function relay(port = 0, dataDir: string | null = null) {
  const r = createRelayServer({ dataDir });
  relays.push(r);
  const bound = await r.listen(port, "127.0.0.1");
  return { relay: r, port: bound, base: `http://127.0.0.1:${bound}` };
}

interface Heard {
  data: string[];
  presence: { data: string; origin?: string }[];
  statuses: TransportStatus[];
  resets: number;
  sink: TransportSink;
}

function listener(): Heard {
  const heard: Heard = {
    data: [],
    presence: [],
    statuses: [],
    resets: 0,
    sink: {
      entries: (batch) => void heard.data.push(...batch.map((e) => e.data)),
      presence: (data, origin) => void heard.presence.push({ data, origin }),
      status: (s) => void heard.statuses.push(s),
      reset: () => void heard.resets++,
    },
  };
  return heard;
}

function transport(base: string, member: string, mode: RelayTransportOptions["mode"], extra: Partial<RelayTransportOptions> = {}) {
  let cursor = 0;
  const t = new RelayTransport({
    baseUrl: base,
    roomId: ROOM,
    token: TOKEN,
    memberId: member,
    mode,
    fetch: (url, init) => fetch(url, init),
    openSocket: (url) => new WebSocket(url),
    cursor: { get: () => cursor, set: (n) => void (cursor = n) },
    retryMs: [20, 100],
    pollWaitS: 1,
    ...extra,
  });
  transports.push(t);
  return t;
}

async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

for (const mode of ["socket", "poll"] as const) {
  describe(`RelayTransport (${mode})`, () => {
    it("carries entries both ways and resolves a publish once the relay has them", async () => {
      const { base } = await relay();
      const ana = transport(base, ANA, mode);
      const ben = transport(base, BEN, mode);
      const heardByAna = listener();
      const heardByBen = listener();
      await ana.start(heardByAna.sink);
      await ben.start(heardByBen.sink);
      await ana.publish(["s1.from-ana"]);
      await ben.publish(["s1.from-ben"]);
      await until(() => heardByBen.data.includes("s1.from-ana") && heardByAna.data.includes("s1.from-ben"));
      expect(heardByAna.statuses.at(-1)?.phase).toBe("live");
    });

    it("catches up on what was sent while it was away", async () => {
      const { base } = await relay();
      const ana = transport(base, ANA, mode);
      await ana.start(listener().sink);
      await ana.publish(["s1.one", "s1.two"]);
      const heard = listener();
      await transport(base, BEN, mode).start(heard.sink);
      await until(() => heard.data.length === 2);
      expect(heard.data).toEqual(["s1.one", "s1.two"]);
    });

    it("passes presence along", async () => {
      const { base } = await relay();
      const ana = transport(base, ANA, mode);
      const heard = listener();
      const ben = transport(base, BEN, mode);
      await ana.start(listener().sink);
      await ben.start(heard.sink);
      await ana.publishPresence("s1.here");
      await until(() => heard.presence.some((p) => p.data === "s1.here" && p.origin === ANA));
    });

    it("says when the relay refuses its token", async () => {
      const { base } = await relay();
      await transport(base, ANA, mode).start(listener().sink);
      const heard = listener();
      await transport(base, BEN, mode, { token: "U".repeat(43) }).start(heard.sink);
      await until(() => heard.statuses.some((s) => s.phase === "problem"));
      expect(heard.statuses.find((s) => s.phase === "problem")?.detail).toMatch(/room code/i);
    });

    it("asks for everything again when the relay has lost its entries", async () => {
      const { base } = await relay();
      const heard = listener();
      let cursor = 50;
      const ben = transport(base, BEN, mode, { cursor: { get: () => cursor, set: (n) => void (cursor = n) } });
      await ben.start(heard.sink);
      await until(() => heard.resets === 1);
      expect(cursor).toBe(0);
    });
  });
}

describe("RelayTransport (socket) through a relay restart", () => {
  it("reconnects and gets what arrived meanwhile; a publish while away rejects", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "studio-collab-relay-"));
    temp.push(dataDir);
    const first = await relay(0, dataDir);
    const heard = listener();
    const ben = transport(first.base, BEN, "socket");
    await ben.start(heard.sink);
    await first.relay.close();
    relays.splice(relays.indexOf(first.relay), 1);
    await until(() => heard.statuses.at(-1)?.phase === "offline");
    await expect(ben.publish(["s1.lost"])).rejects.toThrow();

    const second = await relay(first.port, dataDir);
    const ana = transport(second.base, ANA, "socket");
    await ana.start(listener().sink);
    await ana.publish(["s1.meanwhile"]);
    await until(() => heard.data.includes("s1.meanwhile"));
    await until(() => heard.statuses.at(-1)?.phase === "live");
  });
});
