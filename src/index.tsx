// Studio Collab: a Safelight extension.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 or later;
// see LICENSE.

// The entry point. Safelight imports dist/index.js (built from this file) and
// calls activate() once with the API, scoped to this extension. It registers
// the panel, the presence line under the Library toolbar, the catalogue hook
// that hears develop edits, and the export processor that marks photos
// exported; then the session joins the saved room, if there is one.

import { CollabSession } from "./app/session";
import { hostPorts } from "./app/host-ports";
import { initRuntime } from "./rt";
import type { SafelightAPI } from "./safelight";
import { EXTENSION_ID } from "./settings";
import { CollabPanel } from "./ui/CollabPanel";
import { PresenceBar } from "./ui/PresenceBar";

export const PANEL_ID = `${EXTENSION_ID}.panel`;

let current: CollabSession | null = null;

export function activate(api: SafelightAPI): void {
  const editStored = new Set<(photoId: string) => void>();
  const session = new CollabSession(hostPorts(api, editStored));
  current = session;
  initRuntime(api.react, api.ui, session);

  api.registerPanel({
    id: PANEL_ID,
    title: "Studio Collab",
    component: CollabPanel,
    defaultDock: { module: "library", direction: "right" },
  });
  api.registerSlot({ id: `${EXTENSION_ID}.presence`, slot: "library-subbar", component: PresenceBar });
  api.registerCatalogHooks({
    id: `${EXTENSION_ID}.edits`,
    onEditCommit: async ({ photo }) => {
      for (const cb of editStored) cb(photo.id);
    },
  });
  api.registerExportProcessor({
    id: `${EXTENSION_ID}.exported`,
    label: "Studio Collab",
    settings: [
      {
        key: "markExported",
        label: "Mark exported photos as Exported for the team",
        type: "boolean",
        default: true,
      },
    ],
    process: async (blob, photo, settings) => {
      if (settings.markExported !== false) session.markExported(photo.id);
      return blob;
    },
  });
  session.start();
}

export function deactivate(): void {
  void current?.dispose();
  current = null;
}
