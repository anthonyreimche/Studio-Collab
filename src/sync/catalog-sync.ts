// Between the catalogue and the room. A photo's key is its path in the open
// project ("p:Day 1/IMG_0042.CR3"); its fingerprint (name, size, capture time)
// finds it again where another member opened the shared tree at another level.
// Outgoing: whatever the catalogue holds that the room's state doesn't
// becomes a change. Incoming: whatever the room's state holds that the
// catalogue doesn't is written to it. Comparing values both ways is what keeps
// a value written here from coming back as a new change.

import type { ColorLabel, EditState, ExifData, FlagStatus, CatalogPhoto, DevelopParams } from "../safelight";
import type { Engine } from "./engine";
import type { Applied, Change, FieldValue } from "./state";

export const STAGES = ["shot", "culled", "edited", "exported"] as const;
export type Stage = (typeof STAGES)[number];

export type SyncedPhoto = Pick<
  CatalogPhoto,
  "id" | "filename" | "relPath" | "fileSize" | "rating" | "flag" | "colorLabel" | "keywords" | "copyOf" | "copyName"
> & { exif: Pick<ExifData, "dateTimeOriginal" | "subSecTimeOriginal"> };

export interface CatalogPort {
  photos(): readonly SyncedPhoto[];
  onPhotosChange(listener: () => void): () => void;
  setRating(id: string, rating: number): Promise<void>;
  setFlag(id: string, flag: FlagStatus): Promise<void>;
  setColorLabel(id: string, label: ColorLabel): Promise<void>;
  addKeyword(id: string, keyword: string): Promise<void>;
  removeKeyword(id: string, keyword: string): Promise<void>;
  getEditState(id: string): Promise<EditState | null>;
  putEditState(state: EditState): Promise<void>;
  /** The photo open in Develop, in any window, or null. */
  editingPhotoId(): string | null;
}

export interface CatalogSyncOptions {
  catalog: CatalogPort;
  engine: Engine;
  /** The name a remote edit's history step carries. */
  stepLabel(): string;
  autoStage(): boolean;
  /** How long catalogue changes gather before they are compared. */
  settleMs?: number;
  now?: () => number;
}

/** A single develop value bigger than this isn't synced. */
export const MAX_VALUE_BYTES = 200 * 1024;

const FLAGS: readonly FlagStatus[] = ["none", "pick", "reject"];
const LABELS: readonly ColorLabel[] = ["none", "red", "yellow", "green", "blue", "purple"];

const isFlag = (v: FieldValue | undefined): v is FlagStatus => typeof v === "string" && FLAGS.some((f) => f === v);
const isLabel = (v: FieldValue | undefined): v is ColorLabel => typeof v === "string" && LABELS.some((l) => l === v);
const isRating = (v: FieldValue | undefined): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 5;
export const isStage = (v: FieldValue | undefined): v is Stage => typeof v === "string" && STAGES.some((s) => s === v);

export const stageRank = (s: FieldValue | undefined): number => (isStage(s) ? STAGES.indexOf(s) : 0);

export function photoKey(photo: Pick<CatalogPhoto, "relPath" | "copyOf" | "copyName">): string {
  const path = photo.relPath.replace(/\\/g, "/").normalize("NFC");
  return photo.copyOf ? `p:${path}#copy:${photo.copyName ?? "copy"}` : `p:${path}`;
}

export function fingerprint(photo: SyncedPhoto): string {
  return [photo.filename, photo.fileSize, photo.exif.dateTimeOriginal ?? "", photo.exif.subSecTimeOriginal ?? ""].join("|");
}

const json = (v: unknown) => JSON.stringify(v ?? null);

/** Whether a value read from a peer's state is a JSON value an op may carry. */
function isFieldValue(v: unknown): v is FieldValue {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isFieldValue);
  return typeof v === "object" && v !== undefined && Object.values(v).every(isFieldValue);
}

/** Core fills a missing develop parameter with its default when it loads a
 *  snapshot, so a set of the room's parameters stands as an edit once it holds
 *  the exposure, which every first edit sends with the rest. */
function isDevelopParams(v: Record<string, FieldValue>): v is Record<string, FieldValue> & DevelopParams {
  return typeof v.exposure === "number";
}

function withoutPrefix(fields: Record<string, FieldValue>, prefix: string): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const [k, v] of Object.entries(fields)) out[k.slice(prefix.length)] = v;
  return out;
}

export class CatalogSync {
  private readonly opts: CatalogSyncOptions;
  private byKey = new Map<string, string>();
  private byFingerprint = new Map<string, string[]>();
  private keyOf = new Map<string, string>();
  private indexedFrom: readonly SyncedPhoto[] | null = null;
  private readonly aliases = new Map<string, string>();
  private lastSeen = new Map<string, SyncedPhoto>();
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly editTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubscribe: (() => void) | null = null;
  private running = false;
  /** What the engine merged while catching up, written once it is done. */
  private startup: Applied[] = [];
  /** Photos with remote values being written to the catalogue: compared again
   *  only once the writes are done, so a value half-written isn't sent back as
   *  a change. */
  private readonly writing = new Map<string, number>();
  /** Photos whose remote edit waits until the person leaves them in Develop. */
  readonly deferred = new Set<string>();
  /** Develop values too big to sync, by photo id. */
  readonly oversized = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(opts: CatalogSyncOptions) {
    this.opts = opts;
  }

  private get state() {
    return this.opts.engine.state;
  }

  /** Before the engine starts: the changes made here while it wasn't running,
   *  judged against the state kept from last time. Nothing on a first join,
   *  where the room's values win once they have arrived. */
  recordOfflineChanges(): void {
    if (this.opts.engine.firstJoin) return;
    for (const photo of this.opts.catalog.photos()) this.recordMetadata(photo, false);
  }

  /** Once the engine has caught up: write what arrived meanwhile, then, on a
   *  first join, send what the room has no value for. */
  async begin(): Promise<void> {
    await this.opts.engine.idle();
    this.reindex();
    this.running = true;
    const arrived = this.startup;
    this.startup = [];
    this.applied(arrived);
    const first = this.opts.engine.firstJoin;
    const photos = this.opts.catalog.photos();
    for (const photo of photos) {
      if (first) this.recordMetadata(photo, true);
      this.lastSeen.set(photo.id, photo);
    }
    if (first) for (const photo of photos) await this.recordEdit(photo.id, true);
    this.unsubscribe = this.opts.catalog.onPhotosChange(() => this.scheduleSettle());
  }

  stop(): void {
    this.running = false;
    this.unsubscribe?.();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    for (const t of this.editTimers.values()) clearTimeout(t);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private reindex(): void {
    const photos = this.opts.catalog.photos();
    if (photos === this.indexedFrom) return;
    this.indexedFrom = photos;
    this.byKey = new Map();
    this.byFingerprint = new Map();
    this.keyOf = new Map();
    for (const photo of photos) {
      const key = photoKey(photo);
      this.byKey.set(key, photo.id);
      this.keyOf.set(photo.id, key);
      if (photo.copyOf) continue;
      const fp = fingerprint(photo);
      this.byFingerprint.set(fp, [...(this.byFingerprint.get(fp) ?? []), photo.id]);
    }
  }

  /** The local photo an entity names: by path, else by a fingerprint that one
   *  photo alone has. */
  photoIdFor(entity: string): string | undefined {
    this.reindex();
    const direct = this.byKey.get(entity) ?? this.aliases.get(entity);
    if (direct) return direct;
    const fp = this.state.fingerprints.get(entity);
    const matches = fp ? this.byFingerprint.get(fp) : undefined;
    if (matches?.length !== 1) return undefined;
    this.aliases.set(entity, matches[0]);
    return matches[0];
  }

  keyFor(photoId: string): string | undefined {
    this.reindex();
    return this.keyOf.get(photoId);
  }

  /** Every entity naming the photo: its own key and those relinked to it. */
  private entitiesFor(photoId: string): string[] {
    const own = this.keyFor(photoId);
    const linked = [...this.aliases].filter(([, id]) => id === photoId).map(([entity]) => entity);
    return own ? [own, ...linked] : linked;
  }

  /** The newest value any entity naming the photo holds for `field`. */
  value(photoId: string, field: string): FieldValue | undefined {
    const own = this.keyFor(photoId);
    if (own && this.state.has(own, field)) return this.state.value(own, field);
    for (const entity of this.entitiesFor(photoId)) if (this.state.has(entity, field)) return this.state.value(entity, field);
    return undefined;
  }

  stageOf(photoId: string): Stage {
    const s = this.value(photoId, "stage");
    return isStage(s) ? s : "shot";
  }

  private scheduleSettle(): void {
    if (!this.running || this.settleTimer) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.settle();
    }, this.opts.settleMs ?? 250);
  }

  /** Compare the photos that changed since last time with the room. */
  settle(): void {
    if (!this.running) return;
    const photos = this.opts.catalog.photos();
    const next = new Map<string, SyncedPhoto>();
    for (const photo of photos) {
      if (this.writing.has(photo.id)) {
        const seen = this.lastSeen.get(photo.id);
        if (seen) next.set(photo.id, seen);
        continue;
      }
      next.set(photo.id, photo);
      if (this.lastSeen.get(photo.id) !== photo) this.recordMetadata(photo, false);
    }
    this.lastSeen = next;
  }

  /** The catalogue's metadata for `photo` where the room differs. `seeding`
   *  sends only what the room has no value for. */
  private recordMetadata(photo: SyncedPhoto, seeding: boolean): void {
    const key = photoKey(photo);
    const changes: Change[] = [];
    const differs = (field: string, value: FieldValue, isDefault: boolean) => {
      const held = this.state.has(key, field);
      if (!held && isDefault) return;
      if (held && (seeding || json(this.state.value(key, field)) === json(value))) return;
      changes.push([key, field, value]);
    };
    differs("rating", photo.rating, photo.rating === 0);
    differs("flag", photo.flag, photo.flag === "none");
    differs("label", photo.colorLabel, photo.colorLabel === "none");
    const keywords = new Set(photo.keywords);
    for (const k of keywords) differs(`kw/${k}`, true, false);
    for (const [field, on] of Object.entries(this.state.fields(key, "kw/")))
      if (on === true && !keywords.has(field.slice(3)) && !seeding) changes.push([key, field, false]);
    const culled = changes.some(([, f]) => f === "rating" || f === "flag" || f === "label");
    if (culled && this.opts.autoStage() && stageRank(this.state.value(key, "stage")) < stageRank("culled"))
      changes.push([key, "stage", "culled"]);
    if (changes.length) this.opts.engine.record(changes, { [key]: fingerprint(photo) });
  }

  /** A develop edit was stored for the photo (here or in another window).
   *  `seeding` sends it only when the room holds no edit for the photo. */
  async recordEdit(photoId: string, seeding = false): Promise<void> {
    const photo = this.opts.catalog.photos().find((p) => p.id === photoId);
    if (!photo) return;
    const edit = await this.opts.catalog.getEditState(photoId);
    const snap = edit?.stack[edit.currentIndex];
    if (!snap) return;
    const key = photoKey(photo);
    if (seeding && Object.keys(this.state.fields(key, "e/")).length) return;
    const changes: Change[] = [];
    let tooBig = false;
    const compare = (field: string, value: unknown) => {
      if (!isFieldValue(value)) return;
      const text = json(value);
      if (text.length > MAX_VALUE_BYTES) {
        tooBig = true;
        return;
      }
      if (!this.state.has(key, field) || json(this.state.value(key, field)) !== text) changes.push([key, field, value]);
    };
    for (const [k, v] of Object.entries(snap.params)) compare(`e/p/${k}`, v);
    const bag = snap.paramBag ?? {};
    for (const [k, v] of Object.entries(bag)) compare(`e/b/${k}`, v);
    for (const [field, v] of Object.entries(this.state.fields(key, "e/b/")))
      if (v !== null && !(field.slice(4) in bag)) changes.push([key, field, null]);
    if (tooBig) this.oversized.add(photoId);
    else this.oversized.delete(photoId);
    if (changes.length === 0) return;
    if (this.opts.autoStage() && stageRank(this.state.value(key, "stage")) < stageRank("edited"))
      changes.push([key, "stage", "edited"]);
    this.opts.engine.record(changes, { [key]: fingerprint(photo) });
  }

  /** Mark photos exported (an export processor saw them leave). */
  markExported(photoId: string): void {
    const photo = this.opts.catalog.photos().find((p) => p.id === photoId);
    if (!photo || !this.opts.autoStage()) return;
    const key = photoKey(photo);
    if (this.state.value(key, "stage") !== "exported")
      this.opts.engine.record([[key, "stage", "exported"]], { [key]: fingerprint(photo) });
  }

  setStage(photoIds: string[], stage: Stage): void {
    for (const id of photoIds) {
      const photo = this.opts.catalog.photos().find((p) => p.id === id);
      if (!photo) continue;
      const key = photoKey(photo);
      this.opts.engine.record([[key, "stage", stage]], { [key]: fingerprint(photo) });
    }
  }

  /** The engine merged `applied`: write what changed to the catalogue. A
   *  local op's values came from the catalogue; they are written back only in
   *  case a remote value landed there first, and its edits are already in
   *  place. */
  applied(applied: Applied[], local = false): void {
    if (!this.running) {
      this.startup.push(...applied);
      return;
    }
    const photos = new Set<string>();
    const edits = new Set<string>();
    for (const a of applied) {
      if (!a.entity.startsWith("p:")) continue;
      const id = this.photoIdFor(a.entity);
      if (!id) continue;
      if (!a.field.startsWith("e/")) photos.add(id);
      else if (!local) edits.add(id);
    }
    const byId = new Map(this.opts.catalog.photos().map((p) => [p.id, p]));
    for (const id of photos) {
      const photo = byId.get(id);
      if (photo) void this.writeRemote(photo);
    }
    for (const id of edits) this.scheduleEdit(id);
    if (photos.size || edits.size) this.notify();
  }

  private async writeRemote(photo: SyncedPhoto): Promise<void> {
    this.writing.set(photo.id, (this.writing.get(photo.id) ?? 0) + 1);
    try {
      await this.writeValues(photo);
    } finally {
      const left = (this.writing.get(photo.id) ?? 1) - 1;
      if (left > 0) this.writing.set(photo.id, left);
      else this.writing.delete(photo.id);
      this.scheduleSettle();
    }
  }

  private async writeValues(photo: SyncedPhoto): Promise<void> {
    const c = this.opts.catalog;
    const rating = this.value(photo.id, "rating");
    if (isRating(rating) && rating !== photo.rating) await c.setRating(photo.id, rating);
    const flag = this.value(photo.id, "flag");
    if (isFlag(flag) && flag !== photo.flag) await c.setFlag(photo.id, flag);
    const label = this.value(photo.id, "label");
    if (isLabel(label) && label !== photo.colorLabel) await c.setColorLabel(photo.id, label);
    const has = new Set(photo.keywords);
    const keywordFields: Record<string, FieldValue> = {};
    for (const entity of this.entitiesFor(photo.id).reverse()) Object.assign(keywordFields, this.state.fields(entity, "kw/"));
    for (const [field, on] of Object.entries(keywordFields)) {
      const k = field.slice(3);
      if (on === true && !has.has(k)) await c.addKeyword(photo.id, k);
      if (on === false && has.has(k)) await c.removeKeyword(photo.id, k);
    }
  }

  private scheduleEdit(photoId: string): void {
    if (this.editTimers.has(photoId)) return;
    this.editTimers.set(
      photoId,
      setTimeout(() => {
        this.editTimers.delete(photoId);
        if (this.opts.catalog.editingPhotoId() === photoId) {
          this.deferred.add(photoId);
          this.notify();
        } else void this.applyEdit(photoId);
      }, this.opts.settleMs ?? 250),
    );
  }

  /** Write the room's develop values for the photo into its edit history, as
   *  one new step. */
  async applyEdit(photoId: string): Promise<void> {
    this.deferred.delete(photoId);
    const entity = this.keyFor(photoId) ?? this.entitiesFor(photoId)[0];
    if (!entity) return;
    const fields: Record<string, FieldValue> = {};
    for (const e of [...this.entitiesFor(photoId)].reverse()) Object.assign(fields, this.state.fields(e, "e/"));
    const remoteParams = withoutPrefix(
      Object.fromEntries(Object.entries(fields).filter(([k]) => k.startsWith("e/p/"))),
      "e/p/",
    );
    const remoteBag = withoutPrefix(
      Object.fromEntries(Object.entries(fields).filter(([k]) => k.startsWith("e/b/"))),
      "e/b/",
    );
    const edit = await this.opts.catalog.getEditState(photoId);
    const current = edit?.stack[edit.currentIndex];
    let params: DevelopParams;
    if (current) params = { ...current.params, ...remoteParams };
    else if (isDevelopParams(remoteParams)) params = remoteParams;
    else return;
    const paramBag: Record<string, unknown> = { ...(current?.paramBag ?? {}) };
    for (const [k, v] of Object.entries(remoteBag)) {
      if (v === null) delete paramBag[k];
      else paramBag[k] = v;
    }
    if (current && json(current.params) === json(params) && json(current.paramBag ?? {}) === json(paramBag)) {
      this.notify();
      return;
    }
    const step = { timestamp: (this.opts.now ?? Date.now)(), label: this.opts.stepLabel(), params, paramBag };
    const stack = edit ? [...edit.stack.slice(0, edit.currentIndex + 1), step] : [step];
    await this.opts.catalog.putEditState({ photoId, stack, currentIndex: stack.length - 1 });
    this.notify();
  }

  /** Apply edits that waited for the person to leave the photo, except the
   *  one still open. */
  flushDeferred(): void {
    const open = this.opts.catalog.editingPhotoId();
    for (const id of [...this.deferred]) if (id !== open) void this.applyEdit(id);
  }
}
