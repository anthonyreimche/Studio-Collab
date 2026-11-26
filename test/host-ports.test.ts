// The ports made from the extension API: which window it is comes from
// navigation, not from the page's address.

import { afterEach, describe, expect, it, vi } from "vitest";
import { hostPorts } from "../src/app/host-ports";
import type { SafelightAPI } from "../src/safelight";

function fakeApi(ownModule: string | null): SafelightAPI {
  return {
    navigation: { goTo: vi.fn(), current: () => "develop", useCurrent: () => "develop", ownModule: () => ownModule },
    stores: {
      useCatalogStore: {} as SafelightAPI["stores"]["useCatalogStore"],
      useUIStore: {} as SafelightAPI["stores"]["useUIStore"],
      useProjectStore: {} as SafelightAPI["stores"]["useProjectStore"],
    } as SafelightAPI["stores"],
    sockets: { requestAccess: vi.fn(), status: vi.fn(), list: vi.fn(), revokeAccess: vi.fn() },
    secrets: { available: vi.fn(), get: vi.fn(), set: vi.fn(), delete: vi.fn() },
  } as Partial<SafelightAPI> as SafelightAPI;
}

describe("hostPorts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is the main window unless popped out for a module, whatever the page's address says", () => {
    vi.stubGlobal("indexedDB", {});
    vi.stubGlobal("window", { location: { search: "?detached=develop" } });
    expect(hostPorts(fakeApi(null), new Set()).isMainWindow).toBe(true);
    expect(hostPorts(fakeApi("develop"), new Set()).isMainWindow).toBe(false);
    expect(hostPorts(fakeApi("studio-collab"), new Set()).isMainWindow).toBe(false);
  });

  it("hands the session the sockets and the keychain the app provides", () => {
    vi.stubGlobal("indexedDB", {});
    const ports = hostPorts(fakeApi(null), new Set());
    expect(ports.sockets).not.toBeNull();
    expect(ports.secrets).not.toBeNull();
  });
});
