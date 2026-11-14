// The shared-folder transport against a real temp folder, with the things sync
// tools do to it: files that turn up late, copies made on conflict, a file cut
// off mid-line, temp files, files replaced by shorter ones.

import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FolderTransport, type FolderTransportOptions } from "../src/transport/folder";
import type { TransportSink, TransportStatus } from "../src/transport/types";
import { nodeFolder } from "./support/node-folder";

const ROOM = "0123456789abcdef0123456789abcdef";
const ANA = "aaaaaaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbbbbbb";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-collab-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const memberDir = (root: string, member: string) => join(root, "studio-collab", ROOM, "members", member);

interface Heard {
  entries: { data: string; origin?: string }[];
  presence: { data: string; origin?: string }[];
  statuses: TransportStatus[];
  sink: TransportSink;
}

function listener(): Heard {
  const heard: Heard = {
    entries: [],
    presence: [],
    statuses: [],
    sink: {
      entries: (batch) => void heard.entries.push(...batch),
      presence: (data, origin) => void heard.presence.push({ data, origin }),
      status: (s) => void heard.statuses.push(s),
    },
  };
  return heard;
}

function transport(member: string, root = dir, extra: Partial<FolderTransportOptions> = {}) {
  return new FolderTransport({ root: nodeFolder(root), roomId: ROOM, memberId: member, pollMs: 0, ...extra });
}

const data = (h: Heard, origin?: string) => h.entries.filter((e) => !origin || e.origin === origin).map((e) => e.data);

describe("FolderTransport", () => {
  it("writes each member's entries into its own folder and reads everyone's", async () => {
    const ana = transport(ANA);
    const ben = transport(BEN);
    const heardByBen = listener();
    await ana.start(listener().sink);
    await ben.start(heardByBen.sink);
    await ana.publish(["s1.one", "s1.two"]);
    await ben.poll();
    expect(data(heardByBen, ANA)).toEqual(["s1.one", "s1.two"]);
    expect(readdirSync(memberDir(dir, ANA))).toEqual(["ops-000001.log"]);
    expect(readFileSync(join(memberDir(dir, ANA), "ops-000001.log"), "utf8")).toBe("s1.one\ns1.two\n");
    await ben.poll();
    expect(data(heardByBen, ANA)).toEqual(["s1.one", "s1.two"]);
  });

  it("takes a member's file that the sync tool delivers late", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "studio-collab-remote-"));
    try {
      const ana = transport(ANA, elsewhere);
      await ana.start(listener().sink);
      await ana.publish(["s1.late"]);
      const ben = transport(BEN);
      const heard = listener();
      await ben.start(heard.sink);
      expect(data(heard, ANA)).toEqual([]);
      mkdirSync(memberDir(dir, ANA), { recursive: true });
      copyFileSync(join(memberDir(elsewhere, ANA), "ops-000001.log"), join(memberDir(dir, ANA), "ops-000001.log"));
      await ben.poll();
      expect(data(heard, ANA)).toEqual(["s1.late"]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("waits for a line cut off mid-download, then takes it once", async () => {
    mkdirSync(memberDir(dir, ANA), { recursive: true });
    const file = join(memberDir(dir, ANA), "ops-000001.log");
    writeFileSync(file, "s1.whole\ns1.ha");
    const heard = listener();
    const ben = transport(BEN);
    await ben.start(heard.sink);
    expect(data(heard, ANA)).toEqual(["s1.whole"]);
    appendFileSync(file, "lf\n");
    await ben.poll();
    await ben.poll();
    expect(data(heard, ANA)).toEqual(["s1.whole", "s1.half"]);
  });

  it("reads conflicted copies of every sync tool's naming", async () => {
    mkdirSync(memberDir(dir, ANA), { recursive: true });
    const m = memberDir(dir, ANA);
    writeFileSync(join(m, "ops-000001.log"), "s1.a\n");
    writeFileSync(join(m, "ops-000001 (conflicted copy 2026-11-12).log"), "s1.a\ns1.dropbox\n");
    writeFileSync(join(m, "ops-000001 (1).log"), "s1.gdrive\n");
    writeFileSync(join(m, "ops-000001-DESKTOP-4F2.log"), "s1.onedrive\n");
    writeFileSync(join(m, "ops-000001.sync-conflict-20261112-101010-ABCDEFG.log"), "s1.syncthing\n");
    const heard = listener();
    await transport(BEN).start(heard.sink);
    expect(new Set(data(heard, ANA))).toEqual(new Set(["s1.a", "s1.dropbox", "s1.gdrive", "s1.onedrive", "s1.syncthing"]));
  });

  it("ignores sync tools' temp files and files that aren't logs", async () => {
    mkdirSync(memberDir(dir, ANA), { recursive: true });
    const m = memberDir(dir, ANA);
    writeFileSync(join(m, ".ops-000001.log"), "s1.hidden\n");
    writeFileSync(join(m, "~$ops-000001.log"), "s1.office\n");
    writeFileSync(join(m, "ops-000001.log.tmp"), "s1.tmp\n");
    writeFileSync(join(m, ".~tmp~ops-000002.log"), "s1.tmp2\n");
    writeFileSync(join(m, "notes.txt"), "s1.notes\n");
    const heard = listener();
    await transport(BEN).start(heard.sink);
    expect(data(heard, ANA)).toEqual([]);
  });

  it("reads a file again from the start when it was replaced by a shorter one", async () => {
    mkdirSync(memberDir(dir, ANA), { recursive: true });
    const file = join(memberDir(dir, ANA), "ops-000001.log");
    writeFileSync(file, "s1.one\ns1.two\n");
    const heard = listener();
    const ben = transport(BEN);
    await ben.start(heard.sink);
    writeFileSync(file, "s1.new\n");
    await ben.poll();
    expect(data(heard, ANA)).toEqual(["s1.one", "s1.two", "s1.new"]);
  });

  it("starts a new segment past the size limit, and stops reading a segment once it is complete", async () => {
    const ana = transport(ANA, dir, { maxSegmentLines: 3 });
    await ana.start(listener().sink);
    await ana.publish(["s1.1", "s1.2", "s1.3", "s1.4", "s1.5"]);
    await ana.publish(["s1.6", "s1.7"]);
    const m = memberDir(dir, ANA);
    expect(readdirSync(m).sort()).toEqual(["ops-000001.log", "ops-000002.log", "ops-000003.log"]);
    expect(readFileSync(join(m, "ops-000002.log"), "utf8")).toBe("h1 3\ns1.4\ns1.5\ns1.6\n");

    const reads: string[] = [];
    const heard = listener();
    const ben = new FolderTransport({ root: nodeFolder(dir, reads), roomId: ROOM, memberId: BEN, pollMs: 0 });
    await ben.start(heard.sink);
    expect(data(heard, ANA)).toEqual(["s1.1", "s1.2", "s1.3", "s1.4", "s1.5", "s1.6", "s1.7"]);
    reads.length = 0;
    await ben.poll();
    const touched = reads.filter((r) => r.startsWith(m)).map((r) => r.slice(m.length + 1));
    expect(touched.sort()).toEqual(["ops-000003.log", "presence.log"]);
  });

  it("carries on its own log after a restart instead of starting it over", async () => {
    const first = transport(ANA);
    await first.start(listener().sink);
    await first.publish(["s1.before"]);
    await first.stop();
    const again = transport(ANA);
    const heard = listener();
    await again.start(heard.sink);
    expect(data(heard, ANA)).toEqual(["s1.before"]);
    await again.publish(["s1.after"]);
    expect(readFileSync(join(memberDir(dir, ANA), "ops-000001.log"), "utf8")).toBe("s1.before\ns1.after\n");
  });

  it("passes on presence when it changes", async () => {
    const ana = transport(ANA);
    const heard = listener();
    const ben = transport(BEN);
    await ana.start(listener().sink);
    await ben.start(heard.sink);
    await ana.publishPresence("s1.here");
    await ben.poll();
    await ben.poll();
    expect(heard.presence).toEqual([{ data: "s1.here", origin: ANA }]);
    await ana.publishPresence("s1.moved");
    await ben.poll();
    expect(heard.presence.map((p) => p.data)).toEqual(["s1.here", "s1.moved"]);
  });

  it("says when it can read the folder and when it can't", async () => {
    const heard = listener();
    const ben = transport(BEN);
    await ben.start(heard.sink);
    expect(heard.statuses.at(-1)?.phase).toBe("live");
    const broken = new FolderTransport({
      root: { ...nodeFolder(dir), folder: () => Promise.reject(new Error("The network path was not found.")) },
      roomId: ROOM,
      memberId: BEN,
      pollMs: 0,
    });
    const heardBroken = listener();
    await broken.start(heardBroken.sink);
    expect(heardBroken.statuses.at(-1)).toMatchObject({ phase: "problem", detail: "The network path was not found." });
  });

  it("ignores folders that aren't member folders", async () => {
    mkdirSync(join(dir, "studio-collab", ROOM, "members", "desktop.ini"), { recursive: true });
    writeFileSync(join(dir, "studio-collab", ROOM, "members", "desktop.ini", "ops-000001.log"), "s1.x\n");
    const heard = listener();
    await transport(BEN).start(heard.sink);
    expect(heard.entries).toEqual([]);
  });
});
