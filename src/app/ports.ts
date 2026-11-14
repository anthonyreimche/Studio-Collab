// What the session needs of Safelight, as plain functions. host-ports.ts makes
// them from the extension API; tests make them by hand.

import type { SettingsStore } from "../settings";
import type { CatalogPort } from "../sync/catalog-sync";
import type { LocalStore } from "../sync/local-store";
import type { FolderLike } from "../transport/folder-like";
import type { RelayRequest, SocketLike } from "../transport/relay";
import type { CreatePeer, IceServer } from "../realtime/mesh";

export type SocketAccess = "allowed" | "after-restart" | "not-allowed";

/** Safelight's user-approved live connections (`api.sockets`), on cores that
 *  have them. */
export interface SocketsPort {
  requestAccess(url: string): Promise<SocketAccess>;
  status(url: string): Promise<SocketAccess>;
}

/** Safelight's OS-keychain store (`api.secrets`), on cores that have it. */
export interface SecretsPort {
  available(): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface NetworkPort {
  requestAccess(url: string): Promise<boolean>;
  hasAccess(url: string): Promise<boolean>;
  fetch(url: string, init: RelayRequest): Promise<Response>;
}

export interface Whereabouts {
  module: string;
  /** The photo open in Develop (this window or a pop-out), or null. */
  developPhotoId: string | null;
  /** The photo the person is on: the one in Develop, else the first selected. */
  photoId: string | null;
  selectedIds: string[];
}

export interface AppPorts {
  settings: SettingsStore & { onChange(cb: (key: string) => void): () => void };
  catalog: CatalogPort;
  whereabouts(): Whereabouts;
  onWhereaboutsChange(cb: () => void): () => void;
  /** The open project's folder path (its name where there is no path), or "". */
  projectKey(): string;
  onProjectChange(cb: () => void): () => void;
  pickFolder(replacing: string | null): Promise<{ token: string; label: string } | null>;
  /** The kept folder, or why it can't be used now. */
  openFolder(token: string): Promise<FolderLike | string>;
  network: NetworkPort;
  sockets: SocketsPort | null;
  secrets: SecretsPort | null;
  openSocket(url: string): SocketLike;
  /** WebRTC connections, where the window has them; null where it doesn't. */
  createPeer: CreatePeer | null;
  localStore: LocalStore;
  /** A develop edit was stored for a photo, in any window. */
  onEditStored(cb: (photoId: string) => void): () => void;
  /** Show only photos `test` passes in the grid; null shows every photo. */
  setGridFilter(test: ((photoId: string) => boolean) | null): void;
  copyText(text: string): Promise<void>;
  appVersion: string;
  isMainWindow: boolean;
  /** How often the shared folder is read, in ms; the transport's own when unset. */
  folderPollMs?: number;
  /** STUN servers in place of the public ones (tests use none). */
  iceServers?: IceServer[];
  /** Faster direct-connection timing, for tests. */
  meshTiming?: { gatherMs?: number; connectMs?: number; helloEveryMs?: number };
}
