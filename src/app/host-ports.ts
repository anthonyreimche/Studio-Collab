// The session's ports, made from the extension API Safelight hands activate().

import type { SafelightAPI } from "../safelight";
import { EXTENSION_ID } from "../settings";
import { indexedDbStore } from "../sync/local-store";
import { handleFolder } from "../transport/folder-like";
import { adaptPeer } from "../realtime/rtc-adapter";
import type { AppPorts, SecretsPort, SocketsPort, Whereabouts } from "./ports";

export const APP_VERSION = "1.0.0";
const FILTER_ID = `${EXTENSION_ID}.filter`;
const FOLDER_PICKER_ID = `${EXTENSION_ID}-room`;

const PROBLEMS = {
  gone: "The room's folder isn't there: its drive or share may not be connected.",
  unwritable: "Safelight can't write into the room's folder.",
  unknown: "Safelight doesn't know the room's folder any more. Choose it again.",
} as const;

/** api.sockets, on a Safelight that has it (3.2.5 and later). */
function socketsOf(api: SafelightAPI): SocketsPort | null {
  const sockets: SafelightAPI["sockets"] | undefined = api.sockets;
  return sockets ? { requestAccess: (url) => sockets.requestAccess(url), status: (url) => sockets.status(url) } : null;
}

/** api.secrets, on a Safelight that has it (3.2.5 and later). */
function secretsOf(api: SafelightAPI): SecretsPort | null {
  const secrets: SafelightAPI["secrets"] | undefined = api.secrets;
  return secrets
    ? {
        available: () => secrets.available(),
        get: (key) => secrets.get(key),
        set: (key, value) => secrets.set(key, value),
        delete: (key) => secrets.delete(key),
      }
    : null;
}

export function hostPorts(api: SafelightAPI, editStored: Set<(photoId: string) => void>): AppPorts {
  const { useCatalogStore, useUIStore, useProjectStore } = api.stores;
  const detached = new URLSearchParams(window.location.search).get("detached");

  const whereabouts = (): Whereabouts => {
    const ui = useUIStore.getState();
    const cat = useCatalogStore.getState();
    const developOpen = ui.activeModule === "develop" || ui.detached.has("develop");
    const developPhotoId = developOpen ? cat.activePhotoId : null;
    const selectedIds = [...cat.selectedIds];
    return {
      module: ui.activeModule,
      developPhotoId,
      photoId: developPhotoId ?? selectedIds[0] ?? cat.activePhotoId,
      selectedIds,
    };
  };

  return {
    settings: {
      get: (key, fallback) => api.settings.get(key, fallback),
      set: (key, value) => api.settings.set(key, value),
      onChange: (cb) => api.settings.onChange((key) => cb(key)),
    },
    catalog: {
      photos: () => useCatalogStore.getState().photos,
      onPhotosChange: (listener) =>
        useCatalogStore.subscribe((state, prev) => {
          if (state.photos !== prev.photos) listener();
        }),
      setRating: (id, rating) => useCatalogStore.getState().setRating(id, rating),
      setFlag: (id, flag) => useCatalogStore.getState().setFlag(id, flag),
      setColorLabel: (id, label) => useCatalogStore.getState().setColorLabel(id, label),
      addKeyword: (id, keyword) => useCatalogStore.getState().addKeyword(id, keyword),
      removeKeyword: (id, keyword) => useCatalogStore.getState().removeKeyword(id, keyword),
      getEditState: (id) => api.catalog.getEditState(id),
      putEditState: (state) => api.catalog.putEditState(state),
      editingPhotoId: () => whereabouts().developPhotoId,
    },
    whereabouts,
    onWhereaboutsChange: (cb) => {
      const offUi = useUIStore.subscribe((s, p) => {
        if (s.activeModule !== p.activeModule || s.detached !== p.detached) cb();
      });
      const offCatalog = useCatalogStore.subscribe((s, p) => {
        if (s.activePhotoId !== p.activePhotoId || s.selectedIds !== p.selectedIds) cb();
      });
      return () => {
        offUi();
        offCatalog();
      };
    },
    projectKey: () => {
      const { root, name } = useProjectStore.getState();
      return root ? (api.project.pathOf(root) ?? name) : "";
    },
    onProjectChange: (cb) =>
      useProjectStore.subscribe((s, p) => {
        if (s.root !== p.root) cb();
      }),
    pickFolder: async (replacing) => {
      const picked = await api.project.pickKeptDirectory(FOLDER_PICKER_ID, replacing);
      return picked ? { token: picked.token, label: api.project.pathOf(picked.folder) ?? picked.folder.name } : null;
    },
    openFolder: async (token) => {
      const kept = await api.project.openKeptDirectory(token);
      return "folder" in kept ? handleFolder(kept.folder) : PROBLEMS[kept.problem];
    },
    network: {
      requestAccess: (url) => api.network.requestAccess(url),
      hasAccess: (url) => api.network.hasAccess(url),
      fetch: (url, init) => api.network.fetch(url, init),
    },
    sockets: socketsOf(api),
    secrets: secretsOf(api),
    openSocket: (url) => new WebSocket(url),
    createPeer: typeof RTCPeerConnection === "function" ? (config) => adaptPeer(new RTCPeerConnection(config)) : null,
    localStore: indexedDbStore(),
    onEditStored: (cb) => {
      editStored.add(cb);
      const offBroadcast = api.events.onBroadcast((message) => {
        if (message.type === "edit-update" && message.payload.photoId) cb(message.payload.photoId);
      });
      return () => {
        editStored.delete(cb);
        offBroadcast();
      };
    },
    setGridFilter: (test) =>
      api.registerGridFilter({
        id: FILTER_ID,
        test: (photo) => !test || test(photo.id),
        reads: [],
      }),
    copyText: (text) => navigator.clipboard.writeText(text),
    appVersion: APP_VERSION,
    isMainWindow: !detached,
  };
}
