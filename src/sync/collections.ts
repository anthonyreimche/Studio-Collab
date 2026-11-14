// Team collections: named sets of photos the whole room shares. A collection
// is an entity ("c:<id>") with a name and a deleted flag; membership is a
// field on each photo ("col/<id>"), so two people adding photos at once both
// keep theirs.

import type { CatalogSync } from "./catalog-sync";
import type { Engine } from "./engine";
import type { RoomState } from "./state";

export interface TeamCollection {
  id: string;
  name: string;
  count: number;
}

const ID = /^c:([0-9a-f]{8})$/;

export function listCollections(state: RoomState): TeamCollection[] {
  const counts = new Map<string, number>();
  for (const entity of state.entityKeys("p:"))
    for (const [field, on] of Object.entries(state.fields(entity, "col/")))
      if (on === true) counts.set(field.slice(4), (counts.get(field.slice(4)) ?? 0) + 1);
  const out: TeamCollection[] = [];
  for (const entity of state.entityKeys("c:")) {
    const id = ID.exec(entity)?.[1];
    const name = state.value(entity, "name");
    if (!id || state.value(entity, "deleted") === true || typeof name !== "string") continue;
    out.push({ id, name, count: counts.get(id) ?? 0 });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function createCollection(engine: Engine, name: string): string {
  const id = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
  engine.record([[`c:${id}`, "name", name.trim().slice(0, 120)]]);
  return id;
}

export function renameCollection(engine: Engine, id: string, name: string): void {
  engine.record([[`c:${id}`, "name", name.trim().slice(0, 120)]]);
}

export function deleteCollection(engine: Engine, id: string): void {
  engine.record([[`c:${id}`, "deleted", true]]);
}

export function setMembership(sync: CatalogSync, engine: Engine, photoIds: string[], id: string, member: boolean): void {
  const changes = photoIds.flatMap((photoId) => {
    const key = sync.keyFor(photoId);
    return key ? [[key, `col/${id}`, member] as [string, string, boolean]] : [];
  });
  engine.record(changes);
}

export const inCollection = (sync: CatalogSync, photoId: string, id: string): boolean =>
  sync.value(photoId, `col/${id}`) === true;
