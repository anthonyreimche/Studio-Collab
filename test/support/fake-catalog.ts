// A catalogue for CatalogSync tests: photos replaced (never mutated) on each
// change, as core's store does, and edit histories by photo id.

import type { CatalogPort, SyncedPhoto } from "../../src/sync/catalog-sync";
import type { ColorLabel, DevelopParams, EditState, FlagStatus } from "../../src/safelight";

export function photo(id: string, relPath: string, extra: Partial<SyncedPhoto> = {}): SyncedPhoto {
  return {
    id,
    filename: relPath.split("/").pop() ?? relPath,
    relPath,
    fileSize: 1000 + relPath.length,
    rating: 0,
    flag: "none",
    colorLabel: "none",
    keywords: [],
    exif: { dateTimeOriginal: "2026:11:01 10:00:00", subSecTimeOriginal: relPath.length.toString() },
    ...extra,
  };
}

export interface FakeCatalog extends CatalogPort {
  list: SyncedPhoto[];
  edits: Map<string, EditState>;
  editing: string | null;
  writes: string[];
  get(id: string): SyncedPhoto;
  /** A change made by the person in this catalogue. */
  change(id: string, patch: Partial<SyncedPhoto>): void;
  /** A develop edit made by the person: one new history step. */
  edit(id: string, params: Partial<DevelopParams>, bag?: Record<string, unknown>): void;
  current(id: string): EditState["stack"][number] | undefined;
}

export const BASE_PARAMS = { exposure: 0, contrast: 0, temperature: 5500, tint: 0 };

export function fakeCatalog(photos: SyncedPhoto[]): FakeCatalog {
  const listeners = new Set<() => void>();
  const cat: FakeCatalog = {
    list: photos,
    edits: new Map(),
    editing: null,
    writes: [],
    photos: () => cat.list,
    onPhotosChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get(id) {
      const found = cat.list.find((p) => p.id === id);
      if (!found) throw new Error(`no photo ${id}`);
      return found;
    },
    change(id, patch) {
      cat.list = cat.list.map((p) => (p.id === id ? { ...p, ...patch } : p));
      for (const l of listeners) l();
    },
    async setRating(id, rating) {
      cat.writes.push(`rating ${id} ${rating}`);
      cat.change(id, { rating });
    },
    async setFlag(id, flag: FlagStatus) {
      cat.writes.push(`flag ${id} ${flag}`);
      cat.change(id, { flag });
    },
    async setColorLabel(id, colorLabel: ColorLabel) {
      cat.writes.push(`label ${id} ${colorLabel}`);
      cat.change(id, { colorLabel });
    },
    async addKeyword(id, keyword) {
      cat.writes.push(`+kw ${id} ${keyword}`);
      cat.change(id, { keywords: [...cat.get(id).keywords, keyword] });
    },
    async removeKeyword(id, keyword) {
      cat.writes.push(`-kw ${id} ${keyword}`);
      cat.change(id, { keywords: cat.get(id).keywords.filter((k) => k !== keyword) });
    },
    async getEditState(id) {
      const e = cat.edits.get(id);
      return e ? structuredClone(e) : null;
    },
    async putEditState(state) {
      cat.writes.push(`edit ${state.photoId}`);
      cat.edits.set(state.photoId, structuredClone(state));
    },
    editingPhotoId: () => cat.editing,
    edit(id, params, bag) {
      const held = cat.edits.get(id);
      const cur = held?.stack[held.currentIndex];
      const base = cur?.params ?? { ...BASE_PARAMS };
      const step = {
        timestamp: Date.now(),
        label: "Edit",
        params: { ...base, ...params } as DevelopParams,
        paramBag: { ...(cur?.paramBag ?? {}), ...bag },
      };
      const stack = held ? [...held.stack.slice(0, held.currentIndex + 1), step] : [step];
      cat.edits.set(id, { photoId: id, stack, currentIndex: stack.length - 1 });
    },
    current(id) {
      const e = cat.edits.get(id);
      return e?.stack[e.currentIndex];
    },
  };
  return cat;
}
