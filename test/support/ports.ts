// Session ports over a fake catalogue and a real shared folder on disk.

import type { AppPorts, Whereabouts } from "../../src/app/ports";
import { memoryLocalStore } from "../../src/sync/local-store";
import { fakeCatalog, photo, type FakeCatalog } from "./fake-catalog";
import { nodeFolder } from "./node-folder";

/** Public servers the code under test tried to reach; tests never reach them. */
export const publicSockets: string[] = [];

export interface PortsRig {
  ports: AppPorts;
  catalog: FakeCatalog;
  settings: Map<string, unknown>;
  project: { key: string; fire(): void };
  filter: { test: ((id: string) => boolean) | null };
  where: { now: Whereabouts; fire(): void };
}

export function portsRig(
  name: string,
  sharedFolder: string,
  catalog = fakeCatalog([photo("1", "Day 1/IMG_0001.CR3"), photo("2", "Day 1/IMG_0002.CR3")]),
): PortsRig {
  const settings = new Map<string, unknown>([["profile", { name, role: "culler" }]]);
  const settingsListeners = new Set<(key: string) => void>();
  const projectListeners = new Set<() => void>();
  const whereListeners = new Set<() => void>();
  const project = { key: "/shoots/wedding", fire: () => projectListeners.forEach((l) => l()) };
  const where: PortsRig["where"] = {
    now: { module: "library", developPhotoId: null, photoId: null, selectedIds: [] },
    fire: () => whereListeners.forEach((l) => l()),
  };
  const filter: PortsRig["filter"] = { test: null };
  const ports: AppPorts = {
    settings: {
      get: <T,>(key: string, fallback: T): T => (settings.has(key) ? (settings.get(key) as T) : fallback),
      set: (key, value) => {
        settings.set(key, value);
        settingsListeners.forEach((l) => l(key));
      },
      onChange: (cb) => (settingsListeners.add(cb), () => settingsListeners.delete(cb)),
    },
    catalog,
    whereabouts: () => where.now,
    onWhereaboutsChange: (cb) => (whereListeners.add(cb), () => whereListeners.delete(cb)),
    projectKey: () => project.key,
    onProjectChange: (cb) => (projectListeners.add(cb), () => projectListeners.delete(cb)),
    pickFolder: async () => ({ token: "shared", label: "Shared" }),
    openFolder: async (token) => (token === "shared" ? nodeFolder(sharedFolder) : "That folder isn't connected"),
    network: {
      requestAccess: async () => true,
      hasAccess: async () => true,
      fetch: (url, init) => fetch(url, init),
    },
    sockets: null,
    secrets: null,
    createPeer: null,
    iceServers: [],
    openSocket: (url) => {
      if (/^wss?:\/\/127\.0\.0\.1[:/]/.test(url)) return new WebSocket(url);
      publicSockets.push(url);
      return { send: () => {}, close: () => {}, addEventListener: () => {} };
    },
    localStore: memoryLocalStore(),
    onEditStored: () => () => {},
    setGridFilter: (test) => void (filter.test = test),
    copyText: async () => {},
    appVersion: "1.0.0",
    isMainWindow: true,
    folderPollMs: 20,
  };
  return { ports, catalog, settings, project, filter, where };
}
