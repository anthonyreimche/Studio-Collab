// The room's merged state: one last-writer-wins register per (entity, field).
// Taking an op keeps, for each field it names, whichever change has the newer
// stamp. That makes the state a join of every op ever made: delivery order and
// repeats don't change it, which is what lets sync folders that lag, reorder
// and duplicate files carry it.

import { isStamp, newer, type ChangeStamp } from "./clock";

/** A JSON value as an op carries it. */
export type FieldValue = string | number | boolean | null | FieldValue[] | { [key: string]: FieldValue };

/** One change: the entity ("p:<path>" for a photo, "c:<id>" for a team
 *  collection), the field, and its new value. */
export type Change = [entity: string, field: string, value: FieldValue];

export interface Op {
  v: 1;
  kind: "ops";
  by: string;
  name: string;
  seq: number;
  at: ChangeStamp;
  ch: Change[];
  /** The fingerprint of each photo the op names, to find it again where its
   *  path differs. */
  fp: Record<string, string>;
}

/** A member's whole view of the room, sent when a relay lost its entries: each
 *  register with the stamp it was written with, so taking it is a merge like
 *  any op's. */
export interface StateSnapshot {
  v: 1;
  kind: "state";
  by: string;
  regs: Register4[];
  fp: Record<string, string>;
}

export type Register4 = [entity: string, field: string, value: FieldValue, stamp: ChangeStamp];

export interface Applied {
  entity: string;
  field: string;
  value: FieldValue;
}

interface Register {
  v: FieldValue;
  s: ChangeStamp;
}

export interface RoomStateJSON {
  entities: Record<string, Record<string, [FieldValue, ChangeStamp]>>;
  seen: Record<string, { upTo: number; extra: number[] }>;
  fp?: Record<string, string>;
}

/** The op sequence numbers taken from one member: every number up to `upTo`,
 *  and the ones past it that arrived early. */
class Seen {
  upTo = 0;
  extra = new Set<number>();

  has(seq: number): boolean {
    return seq <= this.upTo || this.extra.has(seq);
  }

  add(seq: number): void {
    if (this.has(seq)) return;
    this.extra.add(seq);
    while (this.extra.delete(this.upTo + 1)) this.upTo++;
  }
}

export class RoomState {
  private readonly entities = new Map<string, Map<string, Register>>();
  private readonly seen = new Map<string, Seen>();
  /** The last fingerprint heard for each photo entity. */
  readonly fingerprints = new Map<string, string>();

  hasSeen(by: string, seq: number): boolean {
    return this.seen.get(by)?.has(seq) ?? false;
  }

  /** The highest sequence number taken from `by` with none missing below it. */
  contiguous(by: string): number {
    return this.seen.get(by)?.upTo ?? 0;
  }

  /** The highest sequence number taken from `by`, gaps or not. */
  highest(by: string): number {
    const seen = this.seen.get(by);
    return seen ? Math.max(seen.upTo, ...seen.extra) : 0;
  }

  private take(entity: string, field: string, value: FieldValue, stamp: ChangeStamp): boolean {
    const fields = this.entities.get(entity) ?? new Map<string, Register>();
    if (!newer(stamp, fields.get(field)?.s)) return false;
    fields.set(field, { v: value, s: stamp });
    this.entities.set(entity, fields);
    return true;
  }

  private noteFingerprints(fp: Record<string, string>): void {
    for (const [entity, print] of Object.entries(fp)) this.fingerprints.set(entity, print);
  }

  /** Take an op; returns the fields whose value it changed. */
  apply(op: Op): Applied[] {
    if (this.hasSeen(op.by, op.seq)) return [];
    const seen = this.seen.get(op.by) ?? new Seen();
    seen.add(op.seq);
    this.seen.set(op.by, seen);
    this.noteFingerprints(op.fp);
    const applied: Applied[] = [];
    for (const [entity, field, value] of op.ch)
      if (this.take(entity, field, value, op.at)) applied.push({ entity, field, value });
    return applied;
  }

  /** Take a snapshot's registers; returns the fields whose value it changed. */
  applySnapshot(snapshot: StateSnapshot): Applied[] {
    this.noteFingerprints(snapshot.fp);
    const applied: Applied[] = [];
    for (const [entity, field, value, stamp] of snapshot.regs)
      if (this.take(entity, field, value, stamp)) applied.push({ entity, field, value });
    return applied;
  }

  /** Every register, for a snapshot. */
  registers(): Register4[] {
    const out: Register4[] = [];
    for (const [entity, fields] of this.entities) for (const [field, reg] of fields) out.push([entity, field, reg.v, reg.s]);
    return out;
  }

  value(entity: string, field: string): FieldValue | undefined {
    return this.entities.get(entity)?.get(field)?.v;
  }

  has(entity: string, field: string): boolean {
    return this.entities.get(entity)?.has(field) ?? false;
  }

  /** The entity's fields whose names start with `prefix`. */
  fields(entity: string, prefix = ""): Record<string, FieldValue> {
    const out: Record<string, FieldValue> = {};
    for (const [field, reg] of this.entities.get(entity) ?? []) if (field.startsWith(prefix)) out[field] = reg.v;
    return out;
  }

  entityKeys(prefix = ""): string[] {
    return [...this.entities.keys()].filter((k) => k.startsWith(prefix));
  }

  /** The newest stamp held anywhere, for a restarted clock to move past. */
  latest(): ChangeStamp | undefined {
    let last: ChangeStamp | undefined;
    for (const fields of this.entities.values()) for (const reg of fields.values()) if (newer(reg.s, last)) last = reg.s;
    return last;
  }

  toJSON(): RoomStateJSON {
    const entities: RoomStateJSON["entities"] = {};
    for (const [entity, fields] of [...this.entities].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const out: Record<string, [FieldValue, ChangeStamp]> = {};
      for (const [field, reg] of [...fields].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out[field] = [reg.v, reg.s];
      entities[entity] = out;
    }
    const seen: RoomStateJSON["seen"] = {};
    for (const [by, s] of this.seen) seen[by] = { upTo: s.upTo, extra: [...s.extra].sort((a, b) => a - b) };
    return { entities, seen, fp: Object.fromEntries(this.fingerprints) };
  }

  static fromJSON(json: RoomStateJSON): RoomState {
    const state = new RoomState();
    for (const [entity, fields] of Object.entries(json.entities ?? {})) {
      const map = new Map<string, Register>();
      for (const [field, pair] of Object.entries(fields))
        if (Array.isArray(pair) && pair.length === 2 && isStamp(pair[1])) map.set(field, { v: pair[0], s: pair[1] });
      state.entities.set(entity, map);
    }
    for (const [by, s] of Object.entries(json.seen ?? {})) {
      const seen = new Seen();
      seen.upTo = Number.isInteger(s.upTo) ? s.upTo : 0;
      for (const n of Array.isArray(s.extra) ? s.extra : []) if (Number.isInteger(n)) seen.extra.add(n);
      state.seen.set(by, seen);
    }
    for (const [entity, print] of Object.entries(json.fp ?? {})) if (typeof print === "string") state.fingerprints.set(entity, print);
    return state;
  }
}
