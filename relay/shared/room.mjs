// Studio Collab relay: one room. Shared by the Node server and the Cloudflare
// Durable Object, each giving it a store. The relay is a dumb, ordering
// mailbox: it numbers the sealed entries it is handed, keeps them, hands them
// out from a number on, and passes presence along. It can't open an entry;
// members do all the merging.

export const PROTOCOL = 1;

export const LIMITS = {
  entryBytes: 256 * 1024,
  roomBytes: 64 * 1024 * 1024,
  roomEntries: 200_000,
  page: 500,
  pushEntries: 500,
  maxWaitMs: 25_000,
  presenceMs: 90_000,
};

const ROOM_ID = /^[0-9a-f]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MEMBER = /^[0-9a-f]{16}$/;

export const validRoomId = (id) => typeof id === "string" && ROOM_ID.test(id);
export const validToken = (token) => typeof token === "string" && TOKEN.test(token);
export const validMember = (member) => typeof member === "string" && MEMBER.test(member);

/** The SHA-256 of `text`, hex. */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares two strings in time that doesn't depend on where they differ. */
function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const byteLength = (text) => new TextEncoder().encode(text).length;

/**
 * @typedef {{ tokenHash: string | null, head: number, bytes: number, count: number }} RoomMeta
 * @typedef {{ seq: number, data: string }} Entry
 * @typedef {{
 *   load(): Promise<RoomMeta | null>,
 *   saveMeta(meta: RoomMeta): Promise<void>,
 *   append(entries: Entry[], meta: RoomMeta): Promise<void>,
 *   range(after: number, limit: number): Promise<Entry[]>,
 * }} RoomStore
 */

export class Room {
  /** @param {RoomStore} store @param {() => number} [now] */
  constructor(store, now = Date.now) {
    this.store = store;
    this.now = now;
    /** @type {RoomMeta | null} */
    this.meta = null;
    /** @type {Map<string, { data: string, at: number }>} */
    this.presence = new Map();
    /** @type {Set<() => void>} */
    this.waiters = new Set();
    this.queue = Promise.resolve();
  }

  /**
   * Runs `task` after every earlier one, so pushes number entries in order.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  serial(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async loaded() {
    if (!this.meta) this.meta = (await this.store.load()) ?? { tokenHash: null, head: 0, bytes: 0, count: 0 };
    return this.meta;
  }

  get head() {
    return this.meta ? this.meta.head : 0;
  }

  /** Whether `token` opens the room. The first token a room is asked with
   *  binds it (trust on first use); its hash is all that is kept. */
  authorize(token) {
    return this.serial(async () => {
      if (!validToken(token)) return false;
      const meta = await this.loaded();
      const hash = await sha256Hex(token);
      if (meta.tokenHash === null) {
        meta.tokenHash = hash;
        await this.store.saveMeta(meta);
        return true;
      }
      return sameText(meta.tokenHash, hash);
    });
  }

  /** Number and keep `entries`. Resolves with their numbers, or an error code. */
  push(entries) {
    return this.serial(async () => {
      if (!Array.isArray(entries) || entries.length === 0 || entries.length > LIMITS.pushEntries)
        return { error: "bad-request" };
      let bytes = 0;
      for (const data of entries) {
        if (typeof data !== "string" || data === "" || data.includes("\n")) return { error: "bad-request" };
        const size = byteLength(data);
        if (size > LIMITS.entryBytes) return { error: "too-large" };
        bytes += size;
      }
      const meta = await this.loaded();
      if (meta.bytes + bytes > LIMITS.roomBytes || meta.count + entries.length > LIMITS.roomEntries)
        return { error: "room-full" };
      const kept = entries.map((data, i) => ({ seq: meta.head + 1 + i, data }));
      const next = { ...meta, head: meta.head + entries.length, bytes: meta.bytes + bytes, count: meta.count + entries.length };
      await this.store.append(kept, next);
      this.meta = next;
      for (const wake of [...this.waiters]) wake();
      return { seqs: kept.map((e) => e.seq), head: next.head, entries: kept };
    });
  }

  /** Up to a page of entries numbered past `after`. */
  async since(after, limit = LIMITS.page) {
    const meta = await this.loaded();
    const from = Number.isInteger(after) && after > 0 ? after : 0;
    const entries = from >= meta.head ? [] : await this.store.range(from, Math.min(limit, LIMITS.page));
    const last = entries.length ? entries[entries.length - 1].seq : from;
    return { entries, head: meta.head, more: last < meta.head };
  }

  /** Like `since`, but when there is nothing yet, wait up to `waitMs` for a push. */
  async waitSince(after, waitMs) {
    const first = await this.since(after);
    const wait = Math.max(0, Math.min(Number(waitMs) || 0, LIMITS.maxWaitMs));
    if (first.entries.length || wait === 0) return first;
    await new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(undefined);
      };
      const timer = setTimeout(wake, wait);
      this.waiters.add(wake);
    });
    return this.since(after);
  }

  setPresence(member, data) {
    if (!validMember(member) || typeof data !== "string" || byteLength(data) > 16 * 1024) return false;
    this.presence.set(member, { data, at: this.now() });
    return true;
  }

  /** Presence sent within the last 90 s, with its age in ms. */
  presenceList() {
    const now = this.now();
    const out = [];
    for (const [member, p] of this.presence) {
      if (now - p.at > LIMITS.presenceMs) this.presence.delete(member);
      else out.push({ member, data: p.data, age: now - p.at });
    }
    return out;
  }
}

/** A store in memory, which `onAppend` may also write somewhere lasting. */
export function memoryStore(initial = null, entries = [], hooks = {}) {
  let meta = initial;
  const kept = [...entries];
  return {
    async load() {
      return meta ? { ...meta } : null;
    },
    async saveMeta(next) {
      meta = { ...next };
      await hooks.onMeta?.(meta);
    },
    async append(list, next) {
      await hooks.onAppend?.(list, next);
      kept.push(...list);
      meta = { ...next };
    },
    async range(after, limit) {
      let lo = 0;
      let hi = kept.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (kept[mid].seq <= after) lo = mid + 1;
        else hi = mid;
      }
      return kept.slice(lo, lo + limit);
    },
  };
}
