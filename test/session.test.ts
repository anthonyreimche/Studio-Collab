// End to end through the shared-folder transport: Ana makes a room in a
// folder, Ben joins it with the code, and their catalogues follow each other
// through real files, sealed with the room's key. Also: the room follows its
// project, the grid filter, and leaving.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollabSession } from "../src/app/session";
import { portsRig, type PortsRig } from "./support/ports";

let shared: string;
const sessions: CollabSession[] = [];
beforeEach(() => {
  shared = mkdtempSync(join(tmpdir(), "studio-collab-shared-"));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.dispose()));
  rmSync(shared, { recursive: true, force: true });
});

interface Rig extends PortsRig {
  session: CollabSession;
}

function rig(name: string): Rig {
  const made = portsRig(name, shared);
  const session = new CollabSession(made.ports);
  sessions.push(session);
  session.start();
  return { ...made, session };
}

async function until(check: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const FOLDER = { transport: "folder", folderToken: "shared", folderLabel: "Shared" } as const;

describe("CollabSession over a shared folder", () => {
  it("syncs two catalogues through the folder, with nothing readable in it", async () => {
    const ana = rig("Ana");
    const code = await ana.session.createRoom(FOLDER);
    expect(ana.session.getView().phase).toBe("running");
    const ben = rig("Ben");
    await ben.session.joinRoom(code, FOLDER);
    expect(ben.session.getView().phase).toBe("running");

    ana.catalog.change("1", { rating: 5, keywords: ["first dance"] });
    await until(() => ben.catalog.get("1").rating === 5);
    expect(ben.catalog.get("1").keywords).toEqual(["first dance"]);
    ben.catalog.change("2", { flag: "reject" });
    await until(() => ana.catalog.get("2").flag === "reject");
    await until(() => ana.session.getView().engine?.members.some((m) => m.name === "Ben") ?? false);

    const room = readdirSync(join(shared, "studio-collab"))[0];
    const members = readdirSync(join(shared, "studio-collab", room, "members"));
    expect(members).toHaveLength(2);
    for (const m of members) {
      const log = readFileSync(join(shared, "studio-collab", room, "members", m, "ops-000001.log"), "utf8");
      expect(log).not.toMatch(/first dance|IMG_0001|Ana|Ben/);
    }
  });

  it("refuses a code that isn't one, and a join with no project open", async () => {
    const ana = rig("Ana");
    await expect(ana.session.joinRoom("slc1-nope", FOLDER)).rejects.toThrow(/room code/);
    ana.project.key = "";
    await expect(ana.session.createRoom(FOLDER)).rejects.toThrow(/Open the shoot/);
  });

  it("stops syncing while another project is open, and starts again when the room's is back", async () => {
    const ana = rig("Ana");
    await ana.session.createRoom(FOLDER);
    ana.project.key = "/shoots/other";
    ana.project.fire();
    await until(() => ana.session.getView().phase === "other-project");
    ana.project.key = "/shoots/wedding";
    ana.project.fire();
    await until(() => ana.session.getView().phase === "running");
  });

  it("says why when the folder isn't there", async () => {
    const code = await rig("Cy").session.createRoom(FOLDER);
    const ana = rig("Ana");
    await ana.session.joinRoom(code, { transport: "folder", folderToken: "gone", folderLabel: "Gone" });
    expect(ana.session.getView()).toMatchObject({ phase: "problem", problem: "That folder isn't connected" });
  });

  it("filters the grid by stage and team collection", async () => {
    const ana = rig("Ana");
    await ana.session.createRoom(FOLDER);
    ana.session.setStage(["1"], "edited");
    const id = ana.session.createCollection("Album");
    if (!id) throw new Error("no collection");
    ana.session.setInCollection(["2"], id, true);
    await until(() => ana.session.getView().collections.length === 1);
    ana.session.setFilter({ stage: "edited", collection: "", hideOthersEditing: false });
    expect(ana.filter.test?.("1")).toBe(true);
    expect(ana.filter.test?.("2")).toBe(false);
    ana.session.setFilter({ stage: "", collection: id, hideOthersEditing: false });
    expect(ana.filter.test?.("1")).toBe(false);
    expect(ana.filter.test?.("2")).toBe(true);
    ana.session.setFilter({ stage: "", collection: "", hideOthersEditing: false });
    expect(ana.filter.test).toBeNull();
  });

  it("keeps the room code in the keychain where there is one, not in the settings", async () => {
    const kept = new Map<string, string>();
    const made = portsRig("Ana", shared);
    made.ports.secrets = {
      available: async () => true,
      get: async (key) => kept.get(key) ?? null,
      set: async (key, value) => void kept.set(key, value),
      delete: async (key) => void kept.delete(key),
    };
    const copied: string[] = [];
    made.ports.copyText = async (text) => void copied.push(text);
    const session = new CollabSession(made.ports);
    sessions.push(session);
    session.start();
    const code = await session.createRoom(FOLDER);
    expect(session.getView().phase).toBe("running");
    expect(kept.get("room-code")).toBe(code);
    expect(JSON.stringify(made.settings.get("room"))).not.toContain(code.slice(5));
    await session.copyCode();
    expect(copied).toEqual([code]);
    await session.leaveRoom();
    expect(kept.size).toBe(0);
  });

  it("forgets the room on leaving", async () => {
    const ana = rig("Ana");
    await ana.session.createRoom(FOLDER);
    await ana.session.leaveRoom();
    expect(ana.session.getView()).toMatchObject({ room: null, phase: "idle" });
    expect(ana.settings.get("room")).toBeNull();
  });
});
