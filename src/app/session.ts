// The room this computer is in, from setup to leaving: builds the transport
// the room is reached by, runs the engine and the catalogue sync while the
// room's project is open, feeds presence, and answers the panel.

import { deriveRoom, makeRoomCode, parseRoomCode, type Room } from "../crypto/room";
import {
  AUTO_STAGE_KEY,
  CODE_SECRET,
  REALTIME_KEY,
  readRealtime,
  writeRealtime,
  type RealtimeSettings,
  memberIdFor,
  readAutoStage,
  readProfile,
  readRoom,
  socketOrigin,
  writeProfile,
  writeRoom,
  type Profile,
  type RoomConfig,
} from "../settings";
import { CatalogSync, type Stage } from "../sync/catalog-sync";
import {
  createCollection,
  deleteCollection,
  inCollection,
  listCollections,
  renameCollection,
  setMembership,
  type TeamCollection,
} from "../sync/collections";
import { Engine, type EngineView } from "../sync/engine";
import { FolderTransport } from "../transport/folder";
import { RelayTransport } from "../transport/relay";
import type { CollabTransport } from "../transport/types";
import { PUBLIC_STUN, type IceServer } from "../realtime/mesh";
import { MeshTransport } from "../realtime/mesh-transport";
import { NostrBus, PUBLIC_NOSTR_RELAYS } from "../realtime/nostr";
import { TrackerBus, PUBLIC_TRACKERS } from "../realtime/tracker";
import type { AppPorts, SocketAccess, Whereabouts } from "./ports";

export type SessionPhase = "idle" | "other-project" | "no-project" | "starting" | "running" | "problem";

export interface GridFilter {
  stage: Stage | "";
  collection: string;
  hideOthersEditing: boolean;
}

export interface SessionView {
  mainWindow: boolean;
  profile: Profile;
  room: RoomConfig | null;
  /** The room's id, which the folder and the relay know it by; not secret. */
  roomId: string;
  phase: SessionPhase;
  problem: string;
  engine: EngineView | null;
  relayMode: "socket" | "poll" | null;
  socketAccess: SocketAccess | "unavailable";
  collections: TeamCollection[];
  filter: GridFilter;
  realtime: RealtimeSettings;
  /** Direct connections can be made in this window. */
  directAvailable: boolean;
  /** Where the person is now: the panel's "this photo". */
  here: Whereabouts;
  revision: number;
}

export interface PhotoInfo {
  stage: Stage;
  /** Names of others on this photo in Develop now. */
  editedBy: string[];
  /** Names of others looking at it now. */
  viewedBy: string[];
  waitingEdit: boolean;
  tooBig: boolean;
  collections: string[];
}

export type SetupChoice =
  | { transport: "folder"; folderToken: string; folderLabel: string }
  | { transport: "relay"; relayUrl: string };

const NO_FILTER: GridFilter = { stage: "", collection: "", hideOthersEditing: false };

export class CollabSession {
  private readonly ports: AppPorts;
  private engine: Engine | null = null;
  private sync: CatalogSync | null = null;
  private room: Room | null = null;
  private view: SessionView;
  private readonly listeners = new Set<() => void>();
  private readonly disposers: (() => void)[] = [];
  private running: Promise<void> = Promise.resolve();
  private filter: GridFilter = NO_FILTER;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDevelopPhoto: string | null = null;

  constructor(ports: AppPorts) {
    this.ports = ports;
    this.view = {
      mainWindow: ports.isMainWindow,
      profile: readProfile(ports.settings),
      room: readRoom(ports.settings),
      roomId: "",
      phase: "idle",
      problem: "",
      engine: null,
      relayMode: null,
      socketAccess: ports.sockets ? "not-allowed" : "unavailable",
      collections: [],
      filter: NO_FILTER,
      realtime: readRealtime(ports.settings),
      directAvailable: !!ports.createPeer,
      here: ports.whereabouts(),
      revision: 0,
    };
  }

  /** Follow the settings and the open project; run the room when they agree. */
  start(): void {
    this.disposers.push(
      this.ports.settings.onChange((key) => {
        if (key === AUTO_STAGE_KEY) return;
        if (key === REALTIME_KEY) {
          this.update({ realtime: readRealtime(this.ports.settings) });
          void this.restart();
          return;
        }
        this.update({ profile: readProfile(this.ports.settings), room: readRoom(this.ports.settings) });
      }),
      this.ports.onProjectChange(() => this.restart()),
      this.ports.onWhereaboutsChange(() => this.whereaboutsChanged()),
      this.ports.onEditStored((id) => void this.sync?.recordEdit(id)),
    );
    this.restart();
  }

  async dispose(): Promise<void> {
    for (const d of this.disposers.splice(0)) d();
    if (this.filterTimer) clearTimeout(this.filterTimer);
    await this.halt();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): SessionView => this.view;

  private update(patch: Partial<SessionView>): void {
    this.view = { ...this.view, ...patch, revision: this.view.revision + 1 };
    for (const l of this.listeners) l();
  }

  private refresh = (): void => {
    this.update({
      engine: this.engine?.view() ?? null,
      collections: this.engine ? listCollections(this.engine.state) : [],
    });
    if (this.filterActive() && !this.filterTimer)
      this.filterTimer = setTimeout(() => {
        this.filterTimer = null;
        this.applyFilter();
      }, 500);
  };

  /** Stop whatever runs, then run the room if this window and project allow. */
  restart(): Promise<void> {
    this.running = this.running.then(async () => {
      await this.halt();
      const room = readRoom(this.ports.settings);
      if (!room) return this.update({ room: null, phase: "idle", problem: "", engine: null });
      if (!this.ports.isMainWindow) return this.update({ room, phase: "idle" });
      const project = this.ports.projectKey();
      if (!project) return this.update({ room, phase: "no-project" });
      if (room.project && room.project !== project) return this.update({ room, phase: "other-project" });
      await this.run(room);
    });
    return this.running;
  }

  private async halt(): Promise<void> {
    const sync = this.sync;
    const engine = this.engine;
    this.sync = null;
    this.engine = null;
    this.room = null;
    sync?.stop();
    await engine?.stop();
    this.ports.setGridFilter(null);
  }

  private async transportFor(room: Room, config: RoomConfig, memberId: string) {
    if (config.transport === "folder") {
      const folder = await this.ports.openFolder(config.folderToken);
      if (typeof folder === "string") throw new Error(folder);
      const pollMs = this.ports.folderPollMs;
      return { mode: null, make: () => new FolderTransport({ root: folder, roomId: room.roomId, memberId, pollMs }) };
    }
    const sockets = this.ports.sockets;
    const socketAccess = sockets ? await sockets.status(socketOrigin(config.relayUrl)) : "unavailable";
    this.update({ socketAccess });
    const mode = socketAccess === "allowed" ? "socket" : "poll";
    if (mode === "poll" && !(await this.ports.network.hasAccess(config.relayUrl)))
      throw new Error("Allow the relay's address first: Safelight hasn't been allowed to reach it.");
    return {
      mode,
      make: (cursor: { get(): number; set(n: number): void }): CollabTransport =>
        new RelayTransport({
          baseUrl: config.relayUrl,
          roomId: room.roomId,
          token: room.relayToken,
          memberId,
          mode,
          fetch: (url, init) => this.ports.network.fetch(url, init),
          openSocket: (url) => this.ports.openSocket(url),
          cursor,
        }),
    } as const;
  }

  /** The room's code, from the settings or the keychain. */
  private async codeOf(config: RoomConfig): Promise<string> {
    if (!config.keychain) return config.code;
    const kept = await this.ports.secrets?.get(CODE_SECRET);
    const code = kept ? parseRoomCode(kept) : null;
    if (!code)
      throw new Error("The room code kept in this computer's keychain can't be read. Leave the room and join again with its code.");
    return code;
  }

  private async run(config: RoomConfig): Promise<void> {
    this.update({ room: config, phase: "starting", problem: "" });
    try {
      const room = await deriveRoom(await this.codeOf(config));
      const memberId = memberIdFor(this.ports.settings, room.roomId);
      const durable = await this.transportFor(room, config, memberId);
      const transport = { mode: durable.mode, make: this.withDirect(durable.make, room, memberId) };
      let sync: CatalogSync | null = null;
      const engine = new Engine({
        room,
        memberId,
        name: () => readProfile(this.ports.settings).name || "Someone",
        transport: transport.make,
        store: this.ports.localStore,
        appVersion: this.ports.appVersion,
        onApplied: (applied) => sync?.applied(applied),
        onLoaded: () => sync?.recordOfflineChanges(),
      });
      sync = new CatalogSync({
        catalog: this.ports.catalog,
        engine,
        stepLabel: () => `Studio Collab: ${this.lastAuthorName(engine)}`,
        autoStage: () => readAutoStage(this.ports.settings),
      });
      this.engine = engine;
      this.sync = sync;
      this.room = room;
      this.update({ roomId: room.roomId });
      engine.subscribe(this.refresh);
      sync.subscribe(this.refresh);
      this.update({ relayMode: transport.mode });
      await engine.start();
      await sync.begin();
      this.whereaboutsChanged();
      this.update({ phase: "running" });
      this.refresh();
    } catch (e) {
      await this.halt();
      this.update({ phase: "problem", problem: e instanceof Error ? e.message : String(e) });
    }
  }

  /** The durable transport with direct connections on top, where the window
   *  has WebRTC. */
  private withDirect(
    make: (cursor: { get(): number; set(n: number): void }) => CollabTransport,
    room: Room,
    memberId: string,
  ): (cursor: { get(): number; set(n: number): void }) => CollabTransport {
    const createPeer = this.ports.createPeer;
    if (!createPeer) return make;
    const settings = readRealtime(this.ports.settings);
    const iceServers: IceServer[] = [...(this.ports.iceServers ?? PUBLIC_STUN)];
    if (settings.turn)
      iceServers.push({ urls: settings.turn.url, username: settings.turn.username, credential: settings.turn.credential });
    const open = (url: string) => this.ports.openSocket(url);
    return (cursor) =>
      new MeshTransport({
        durable: make(cursor),
        room,
        memberId,
        createPeer,
        iceServers,
        publicBuses: settings.publicSignalling
          ? [new NostrBus(PUBLIC_NOSTR_RELAYS, open), new TrackerBus(PUBLIC_TRACKERS, open)]
          : [],
        mesh: this.ports.meshTiming,
      });
  }

  setRealtime(value: RealtimeSettings): void {
    writeRealtime(this.ports.settings, value);
  }

  private lastAuthorName(engine: Engine): string {
    const recent = engine
      .view()
      .members.filter((m) => m.lastChangeAt !== null)
      .sort((a, b) => (b.lastChangeAt ?? 0) - (a.lastChangeAt ?? 0))[0];
    return recent?.name ?? "the team";
  }

  private whereaboutsChanged(): void {
    const where = this.ports.whereabouts();
    this.update({ here: where });
    const engine = this.engine;
    const sync = this.sync;
    if (!engine || !sync) return;
    const photo = where.photoId ? (sync.keyFor(where.photoId) ?? "") : "";
    engine.setPresence({
      role: readProfile(this.ports.settings).role,
      module: where.module,
      photo,
      editing: !!where.developPhotoId && where.developPhotoId === where.photoId,
    });
    if (where.developPhotoId !== this.lastDevelopPhoto) {
      this.lastDevelopPhoto = where.developPhotoId;
      sync.flushDeferred();
    }
  }

  setProfile(profile: Profile): void {
    writeProfile(this.ports.settings, profile);
    this.update({ profile: readProfile(this.ports.settings) });
    this.whereaboutsChanged();
  }

  /** Make a room and enter it; resolves with its code. */
  async createRoom(choice: SetupChoice): Promise<string> {
    const code = makeRoomCode();
    await this.joinRoom(code, choice);
    return code;
  }

  async joinRoom(codeText: string, choice: SetupChoice): Promise<void> {
    const code = parseRoomCode(codeText);
    if (!code) throw new Error("That isn't a room code: it starts with slc1- and is 48 characters long.");
    const project = this.ports.projectKey();
    if (!project) throw new Error("Open the shoot's folder first: the room follows the project it was joined in.");
    const secrets = this.ports.secrets;
    const keychain = !!secrets && (await secrets.available());
    if (secrets && keychain) await secrets.set(CODE_SECRET, code);
    writeRoom(this.ports.settings, { code: keychain ? "" : code, keychain, project, ...choice });
    await this.restart();
  }

  async leaveRoom(): Promise<void> {
    const room = this.room;
    const config = readRoom(this.ports.settings);
    writeRoom(this.ports.settings, null);
    if (config?.keychain) await this.ports.secrets?.delete(CODE_SECRET);
    await this.restart();
    if (room) await this.ports.localStore.remove(room.roomId);
  }

  /** Point the room at the project open now, after it was opened elsewhere. */
  async useOpenProject(): Promise<void> {
    const room = readRoom(this.ports.settings);
    const project = this.ports.projectKey();
    if (!room || !project) return;
    writeRoom(this.ports.settings, { ...room, project });
    await this.restart();
  }

  pickFolder(): Promise<{ token: string; label: string } | null> {
    return this.ports.pickFolder(null);
  }

  autoStage(): boolean {
    return readAutoStage(this.ports.settings);
  }

  setAutoStage(on: boolean): void {
    this.ports.settings.set(AUTO_STAGE_KEY, on);
    this.update({});
  }

  async copyCode(): Promise<void> {
    const room = readRoom(this.ports.settings);
    if (room) await this.ports.copyText(await this.codeOf(room));
  }

  async allowRelay(relayUrl: string): Promise<boolean> {
    return this.ports.network.requestAccess(relayUrl);
  }

  async allowLiveConnection(relayUrl: string): Promise<SocketAccess | "unavailable"> {
    const sockets = this.ports.sockets;
    if (!sockets) return "unavailable";
    let access: SocketAccess;
    try {
      access = await sockets.requestAccess(socketOrigin(relayUrl));
    } catch (e) {
      this.update({ problem: e instanceof Error ? e.message : String(e) });
      return "not-allowed";
    }
    this.update({ socketAccess: access });
    if (access === "allowed") await this.restart();
    return access;
  }

  photoInfo(photoId: string): PhotoInfo | null {
    const sync = this.sync;
    const engine = this.engine;
    if (!sync || !engine) return null;
    const key = sync.keyFor(photoId);
    const here = engine.view().members.filter((m) => m.fresh && key && m.photo === key);
    return {
      stage: sync.stageOf(photoId),
      editedBy: here.filter((m) => m.editing).map((m) => m.name),
      viewedBy: here.filter((m) => !m.editing).map((m) => m.name),
      waitingEdit: sync.deferred.has(photoId),
      tooBig: sync.oversized.has(photoId),
      collections: listCollections(engine.state)
        .filter((c) => inCollection(sync, photoId, c.id))
        .map((c) => c.id),
    };
  }

  /** The file name of the photo a member's presence names, for the panel. */
  photoNameFor(key: string): string {
    return key.replace(/^p:/, "").replace(/#copy:.*$/, "").split("/").pop() ?? "";
  }

  setStage(photoIds: string[], stage: Stage): void {
    this.sync?.setStage(photoIds, stage);
  }

  markExported(photoId: string): void {
    this.sync?.markExported(photoId);
  }

  applyWaitingEdit(photoId: string): Promise<void> {
    return this.sync?.applyEdit(photoId) ?? Promise.resolve();
  }

  createCollection(name: string): string | null {
    return this.engine && name.trim() ? createCollection(this.engine, name) : null;
  }

  renameCollection(id: string, name: string): void {
    if (this.engine && name.trim()) renameCollection(this.engine, id, name);
  }

  deleteCollection(id: string): void {
    if (this.engine) deleteCollection(this.engine, id);
    if (this.filter.collection === id) this.setFilter({ ...this.filter, collection: "" });
  }

  setInCollection(photoIds: string[], id: string, member: boolean): void {
    if (this.engine && this.sync) setMembership(this.sync, this.engine, photoIds, id, member);
  }

  setFilter(filter: GridFilter): void {
    this.filter = filter;
    this.update({ filter });
    this.applyFilter();
  }

  private filterActive(): boolean {
    return !!(this.filter.stage || this.filter.collection || this.filter.hideOthersEditing);
  }

  private applyFilter(): void {
    const sync = this.sync;
    const engine = this.engine;
    if (!sync || !engine || !this.filterActive()) {
      this.ports.setGridFilter(null);
      return;
    }
    const { stage, collection, hideOthersEditing } = this.filter;
    const editing = new Set(engine.view().members.filter((m) => m.fresh && m.editing).map((m) => m.photo));
    this.ports.setGridFilter((photoId) => {
      if (stage && sync.stageOf(photoId) !== stage) return false;
      if (collection && !inCollection(sync, photoId, collection)) return false;
      if (hideOthersEditing && editing.has(sync.keyFor(photoId) ?? "")) return false;
      return true;
    });
  }
}
