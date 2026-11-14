// What a member keeps of a room on its own computer between launches: the
// merged state, its place in the relay's stream, the entries not yet sent, its
// own op count and its clock. Losing it costs a full catch-up, nothing else.

import type { RoomStateJSON } from "./state";

export interface RoomRecord {
  state: RoomStateJSON;
  cursor: number;
  outbox: string[];
  seq: number;
  clock: number;
}

export interface LocalStore {
  load(roomId: string): Promise<RoomRecord | null>;
  save(roomId: string, record: RoomRecord): Promise<void>;
  remove(roomId: string): Promise<void>;
}

export function memoryLocalStore(): LocalStore & { records: Map<string, RoomRecord> } {
  const records = new Map<string, RoomRecord>();
  return {
    records,
    async load(roomId) {
      const found = records.get(roomId);
      return found ? structuredClone(found) : null;
    },
    async save(roomId, record) {
      records.set(roomId, structuredClone(record));
    },
    async remove(roomId) {
      records.delete(roomId);
    },
  };
}

const DB_NAME = "studio-collab";
const STORE = "rooms";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function isRoomRecord(v: unknown): v is RoomRecord {
  return (
    typeof v === "object" &&
    v !== null &&
    "state" in v &&
    "cursor" in v &&
    "outbox" in v &&
    "seq" in v &&
    "clock" in v &&
    typeof v.cursor === "number" &&
    Array.isArray(v.outbox) &&
    typeof v.seq === "number" &&
    typeof v.clock === "number"
  );
}

/** Rooms kept in the window's IndexedDB. */
export function indexedDbStore(factory: IDBFactory = indexedDB): LocalStore {
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => {
    if (!opened) {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      opened = request(req);
    }
    return opened;
  };
  const tx = async (mode: IDBTransactionMode) => (await db()).transaction(STORE, mode).objectStore(STORE);
  return {
    async load(roomId) {
      const value: unknown = await request((await tx("readonly")).get(roomId));
      return isRoomRecord(value) ? value : null;
    },
    async save(roomId, record) {
      await request((await tx("readwrite")).put(record, roomId));
    },
    async remove(roomId) {
      await request((await tx("readwrite")).delete(roomId));
    },
  };
}
