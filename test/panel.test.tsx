// @vitest-environment jsdom
// The panel, driven like a person would: make a room in a shared folder, see
// the room, a teammate's presence, the photo's stage and "being edited by",
// make a team collection, and leave through the app's own confirmation.

import { webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CollabSession } from "../src/app/session";
import { initRuntime } from "../src/rt";
import { CollabPanel } from "../src/ui/CollabPanel";
import { PresenceBar } from "../src/ui/PresenceBar";
import nodeDataChannel from "node-datachannel";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { adaptPeer } from "../src/realtime/rtc-adapter";
import type { CreatePeer } from "../src/realtime/mesh";
import { linkLabel } from "../src/ui/format";
import { confirmed, fakeUi } from "./support/fake-ui";
import { portsRig, publicSockets } from "./support/ports";

afterAll(() => nodeDataChannel.cleanup());

beforeAll(() => {
  if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
});

let shared: string;
const sessions: CollabSession[] = [];
beforeEach(() => {
  shared = mkdtempSync(join(tmpdir(), "studio-collab-panel-"));
  confirmed.titles = [];
  confirmed.answer = true;
});
afterEach(async () => {
  cleanup();
  await Promise.all(sessions.splice(0).map((s) => s.dispose()));
  rmSync(shared, { recursive: true, force: true });
});

function start(name: string, createPeer: CreatePeer | null = null) {
  const rig = portsRig(name, shared);
  rig.ports.createPeer = createPeer;
  rig.ports.meshTiming = { gatherMs: 1000, connectMs: 3000, helloEveryMs: 200 };
  rig.settings.set("realtime", { publicSignalling: false, turn: null });
  const session = new CollabSession(rig.ports);
  sessions.push(session);
  session.start();
  return { ...rig, session };
}

describe("CollabPanel", () => {
  it("makes a room in a shared folder and shows it", async () => {
    const ana = start("Ana");
    initRuntime(React, fakeUi, ana.session);
    render(<CollabPanel />);
    expect(screen.getByRole("button", { name: "Create room" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await screen.findByRole("button", { name: "Shared" });
    fireEvent.click(screen.getByRole("button", { name: "Create room" }));
    await screen.findByText("Nobody else has been heard from yet.");
    expect(screen.getByText(/^Shared folder: Shared\. It keeps the record/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy room code" })).toBeTruthy();
  });

  it("shows a teammate, the photo's stage and who is editing it", async () => {
    const ana = start("Ana");
    const code = await ana.session.createRoom({ transport: "folder", folderToken: "shared", folderLabel: "Shared" });
    const ben = start("Ben");
    await ben.session.joinRoom(code, { transport: "folder", folderToken: "shared", folderLabel: "Shared" });
    ben.where.now = { module: "develop", developPhotoId: "1", photoId: "1", selectedIds: ["1"] };
    ben.where.fire();

    ana.where.now = { module: "library", developPhotoId: null, photoId: "1", selectedIds: ["1"] };
    ana.where.fire();
    initRuntime(React, fakeUi, ana.session);
    render(
      <>
        <PresenceBar />
        <CollabPanel />
      </>,
    );
    await waitFor(() => expect(screen.getByText("Being edited by Ben")).toBeTruthy(), { timeout: 5000 });
    expect(screen.getAllByText(/editing IMG_0001\.CR3/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Edited" }));
    await waitFor(() => expect(ben.session.photoInfo("1")?.stage).toBe("edited"), { timeout: 5000 });
  });

  it("makes a team collection and adds the selected photo", async () => {
    const ana = start("Ana");
    await ana.session.createRoom({ transport: "folder", folderToken: "shared", folderLabel: "Shared" });
    ana.where.now = { module: "library", developPhotoId: null, photoId: "2", selectedIds: ["2"] };
    ana.where.fire();
    initRuntime(React, fakeUi, ana.session);
    render(<CollabPanel />);
    fireEvent.change(screen.getByLabelText("New collection name"), { target: { value: "Album" } });
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await screen.findByText("Album");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(ana.session.photoInfo("2")?.collections.length).toBe(1));
  });

  it("leaves the room only after the app's own confirmation", async () => {
    const ana = start("Ana");
    await ana.session.createRoom({ transport: "folder", folderToken: "shared", folderLabel: "Shared" });
    initRuntime(React, fakeUi, ana.session);
    render(<CollabPanel />);
    confirmed.answer = false;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Leave room" })));
    expect(confirmed.titles).toEqual(["Leave room"]);
    expect(ana.session.getView().room).not.toBeNull();
    confirmed.answer = true;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Leave room" })));
    await screen.findByRole("button", { name: "Create room" });
  });

  it("says it runs in the main window when opened in a pop-out", () => {
    const rig = portsRig("Ana", shared);
    const session = new CollabSession({ ...rig.ports, isMainWindow: false });
    sessions.push(session);
    initRuntime(React, fakeUi, session);
    render(<CollabPanel />);
    expect(screen.getByText(/runs in the main window/)).toBeTruthy();
  });
});

const realPeer: CreatePeer = (config) => adaptPeer(new RTCPeerConnection(config));
const FOLDER = { transport: "folder", folderToken: "shared", folderLabel: "Shared" } as const;

describe("the path each teammate is on", () => {
  it("is put in words", () => {
    expect(linkLabel({ link: "direct", rttMs: 12, connecting: false })).toBe("direct, 12 ms");
    expect(linkLabel({ link: "direct", rttMs: null, connecting: false })).toBe("direct");
    expect(linkLabel({ link: "relay", rttMs: null, connecting: false })).toBe("relay");
    expect(linkLabel({ link: "folder", rttMs: null, connecting: false })).toBe("via folder, slower");
    expect(linkLabel({ link: "folder", rttMs: null, connecting: true })).toBe("via folder, slower (connecting directly…)");
  });

  it("shows direct, with its round trip, once teammates connect", async () => {
    const ana = start("Ana", realPeer);
    const code = await ana.session.createRoom(FOLDER);
    const ben = start("Ben", realPeer);
    await ben.session.joinRoom(code, FOLDER);
    initRuntime(React, fakeUi, ana.session);
    render(<CollabPanel />);
    await waitFor(() => expect(screen.getByText(/^direct, \d+ ms$/)).toBeTruthy(), { timeout: 15_000 });
  }, 20_000);

  it("shows the folder when a direct connection can't be made", async () => {
    const ana = start("Ana");
    const code = await ana.session.createRoom(FOLDER);
    const ben = start("Ben");
    await ben.session.joinRoom(code, FOLDER);
    ben.where.now = { module: "library", developPhotoId: null, photoId: "1", selectedIds: ["1"] };
    ben.where.fire();
    initRuntime(React, fakeUi, ana.session);
    render(<CollabPanel />);
    await waitFor(() => expect(screen.getByText("via folder, slower")).toBeTruthy(), { timeout: 5000 });
  });

  it("keeps the internet switch and a TURN server in the settings", async () => {
    const ana = start("Ana", realPeer);
    await ana.session.createRoom(FOLDER);
    initRuntime(React, fakeUi, ana.session);
    render(<CollabPanel />);
    fireEvent.click(await screen.findByText("Find teammates over the internet"));
    await waitFor(() => expect(ana.settings.get("realtime")).toMatchObject({ publicSignalling: true }));
    await waitFor(() => expect(publicSockets).toEqual(expect.arrayContaining(["wss://relay.damus.io", "wss://tracker.openwebtorrent.com"])));
    fireEvent.change(await screen.findByLabelText("TURN server", {}, { timeout: 5000 }), { target: { value: "turns:turn.example:5349" } });
    fireEvent.change(screen.getByLabelText("TURN user name"), { target: { value: "studio" } });
    fireEvent.change(screen.getByLabelText("TURN password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(ana.settings.get("realtime")).toMatchObject({ turn: { url: "turns:turn.example:5349", username: "studio", credential: "pw" } }),
    );
  });
});
