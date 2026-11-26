// The manifest and package agree, name what the extension uses, and its
// contributions sit under its own id.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../safelight.json";
import { PANEL_ID } from "../src/index";
import { EXTENSION_ID } from "../src/settings";
import { APP_VERSION } from "../src/app/host-ports";
import { PUBLIC_NOSTR_RELAYS } from "../src/realtime/nostr";
import { PUBLIC_TRACKERS } from "../src/realtime/tracker";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("manifest", () => {
  it("keeps one version and licence across the manifest, the package and the code", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(APP_VERSION).toBe(manifest.version);
    expect(manifest.license).toBe("GPL-3.0-or-later");
    expect(pkg.license).toBe("GPL-3.0-or-later");
  });

  it("names its contributions under its id", () => {
    expect(EXTENSION_ID).toBe(manifest.id);
    expect(PANEL_ID.startsWith(`${manifest.id}.`)).toBe(true);
  });

  it("asks for addresses the person enters, and declares every public signalling server it uses", () => {
    expect(manifest.permissions.userOrigins).toBe(true);
    expect(manifest.permissions.userSockets).toBe(true);
    expect([...manifest.permissions.network].sort()).toEqual([...PUBLIC_NOSTR_RELAYS, ...PUBLIC_TRACKERS].sort());
    for (const origin of manifest.permissions.network) expect(origin).toMatch(/^wss:\/\/[a-z0-9.-]+(:\d+)?$/);
    expect(manifest.minAppVersion).toBe("3.2.8");
  });
});
