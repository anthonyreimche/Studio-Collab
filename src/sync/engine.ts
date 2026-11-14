// The engine: turns this member's changes into sealed ops, takes everyone's
// ops into the merged state, and keeps presence. It knows nothing of the
// catalogue (CatalogSync does) or of the medium (the transport does).

import { openEntry, sealEntry, type Room } from "../crypto/room";
import type { CollabTransport, ReceivedEntry, TransportPhase, TransportSink } from "../transport/types";
import { ChangeClock } from "./clock";
import type { LocalStore, RoomRecord } from "./local-store";
import { readPayload, type Presence, type Role } from "./payload";
import { RoomState, type Applied, type Change, type Op } from "./state";

const MAX_CHANGES_PER_OP = 400;
const MAX_OUTBOX_BATCH = 200;
const SAVE_DELAY_MS = 2000;
const RETRY_MS = 5000;
const TICK_MS = 5000;

export interface Cursor {
  get(): number;
  set(n: number): void;
}

export interface EngineOptions {
  room: Room;
  memberId: string;
  name(): string;
  /** Made by the engine's caller, given the engine's place in the stream. */
  transport(cursor: Cursor): CollabTransport;
  store: LocalStore;
  now?: () => number;
  /** How long local changes gather before they become one op. */
  flushMs?: number;
  appVersion?: string;
  /** The fields ops changed in the merged state; `local` for this member's
   *  own new ops. */
  onApplied?(applied: Applied[], local: boolean): void;
  /** After the kept record is read and before catching up: the moment to
   *  record changes made while the engine wasn't running. */
  onLoaded?(): void;
}

export interface OwnPresence {
  role: Role | "";
  module: string;
  photo: string;
  editing: boolean;
}

export interface MemberView {
  id: string;
  name: string;
  role: Role | "";
  module: string;
  photo: string;
  editing: boolean;
  /** When this member's presence was written, by its clock; null when never seen. */
  seenAt: number | null;
  fresh: boolean;
  /** When an op from this member last arrived here. */
  lastChangeAt: number | null;
  /** How this member's changes reach this computer now: a direct connection,
   *  else the relay or the shared folder. */
  link: MemberLink;
  /** A direct connection is being set up. */
  connecting: boolean;
  /** Round trip over the direct connection, in ms. */
  rttMs: number | null;
}

export type MemberLink = "direct" | "relay" | "folder";

export interface HeldView {
  by: string;
  name: string;
  aheadMs: number;
}

export interface EngineView {
  ready: boolean;
  kind: string;
  realtime: boolean;
  phase: TransportPhase;
  detail: string;
  members: MemberView[];
  unsent: number;
  rejected: number;
  held: HeldView[];
}

interface HeardPresence {
  presence: Presence;
  receivedAt: number;
}

export class Engine {
  state = new RoomState();
  private readonly opts: EngineOptions;
  private readonly now: () => number;
  private clock: ChangeClock;
  private transport: CollabTransport | null = null;
  private cursor = 0;
  private seq = 0;
  private outbox: string[] = [];
  private pending: { changes: Change[]; fp: Record<string, string> }[] = [];
  private held: Op[] = [];
  private readonly presence = new Map<string, HeardPresence>();
  private readonly names = new Map<string, string>();
  private readonly lastChange = new Map<string, number>();
  private own: OwnPresence = { role: "", module: "", photo: "", editing: false };
  private phase: TransportPhase = "connecting";
  private detail = "";
  private rejected = 0;
  private work: Promise<void> = Promise.resolve();
  private publishing: Promise<void> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private presenceTimerEvery: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();
  private stopped = false;
  ready = false;
  /** No record of this room was kept here: the member is joining afresh, and
   *  the room's values win over the catalogue's. */
  firstJoin = true;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.clock = new ChangeClock(opts.memberId, this.now);
  }

  get memberId(): string {
    return this.opts.memberId;
  }

  get realtime(): boolean {
    return this.transport?.realtime ?? false;
  }

  async start(): Promise<void> {
    const record = await this.opts.store.load(this.opts.room.roomId);
    this.firstJoin = !record;
    if (record) {
      this.state = RoomState.fromJSON(record.state);
      this.cursor = record.cursor;
      this.outbox = [...record.outbox];
      this.seq = record.seq;
    }
    this.clock = new ChangeClock(this.opts.memberId, this.now, Math.max(record?.clock ?? 0, this.state.latest()?.[0] ?? 0));
    this.opts.onLoaded?.();
    const transport = this.opts.transport({ get: () => this.cursor, set: (n) => this.setCursor(n) });
    this.transport = transport;
    await transport.start(this.sink());
    await this.idle();
    this.seq = Math.max(this.seq, this.state.highest(this.opts.memberId));
    this.ready = true;
    const presenceEvery = transport.realtime ? 15_000 : 30_000;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.presenceTimerEvery = setInterval(() => void this.sendPresence(), presenceEvery);
    this.flush();
    void this.publishOutbox();
    void this.sendPresence();
    this.notify();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flush();
    this.stopped = true;
    for (const t of [this.saveTimer, this.presenceTimer]) if (t) clearTimeout(t);
    for (const t of this.timers) clearTimeout(t);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.presenceTimerEvery) clearInterval(this.presenceTimerEvery);
    await this.work;
    await this.transport?.stop();
    await this.save();
  }

  /** Changes made here, by the catalogue's values. `fp` gives the fingerprint
   *  of each photo they name. */
  record(changes: Change[], fp: Record<string, string> = {}): void {
    if (changes.length === 0) return;
    this.pending.push({ changes, fp });
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.opts.flushMs ?? 100);
  }

  setPresence(next: OwnPresence): void {
    const same =
      next.role === this.own.role &&
      next.module === this.own.module &&
      next.photo === this.own.photo &&
      next.editing === this.own.editing;
    this.own = next;
    if (same || !this.ready || this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      void this.sendPresence();
    }, 150);
  }

  /** Resolves once everything that has arrived or been recorded is taken in. */
  async idle(): Promise<void> {
    for (;;) {
      const work = this.work;
      await work;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.flush();
      }
      if (this.publishing) await this.publishing;
      if (this.work === work && !this.flushTimer && !this.publishing) return;
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  view(): EngineView {
    const now = this.now();
    const freshMs = this.realtime ? 90_000 : 240_000;
    const links = this.transport?.links?.() ?? {};
    const fallback: MemberLink = this.transport?.kind === "relay" ? "relay" : "folder";
    const ids = new Set([...this.presence.keys(), ...this.names.keys(), ...Object.keys(links)]);
    ids.delete(this.opts.memberId);
    const members: MemberView[] = [...ids].map((id) => {
      const heard = this.presence.get(id)?.presence;
      return {
        id,
        name: heard?.name || this.names.get(id) || "Someone",
        role: heard?.role ?? "",
        module: heard?.module ?? "",
        photo: heard?.photo ?? "",
        editing: heard?.editing ?? false,
        seenAt: heard?.wall ?? null,
        fresh: !!heard && Math.abs(now - heard.wall) <= freshMs,
        lastChangeAt: this.lastChange.get(id) ?? null,
        link: links[id]?.state === "open" ? "direct" : fallback,
        connecting: links[id]?.state === "connecting",
        rttMs: links[id]?.state === "open" ? links[id].rttMs : null,
      };
    });
    members.sort((a, b) => Number(b.fresh) - Number(a.fresh) || a.name.localeCompare(b.name));
    const ahead = new Map<string, number>();
    for (const op of this.held) ahead.set(op.by, Math.max(ahead.get(op.by) ?? 0, op.at[0] - now));
    return {
      ready: this.ready,
      kind: this.transport?.kind ?? "",
      realtime: this.realtime,
      phase: this.phase,
      detail: this.detail,
      members,
      unsent: this.outbox.length + this.pending.length,
      rejected: this.rejected,
      held: [...ahead].map(([by, aheadMs]) => ({ by, name: this.names.get(by) || "Someone", aheadMs })),
    };
  }

  /** Release ops that were too far ahead once this clock has caught up. */
  tick(): void {
    if (this.held.length === 0) return;
    this.enqueue(async () => {
      const due = this.held.filter((op) => !this.clock.tooFarAhead(op.at));
      if (due.length === 0) return;
      this.held = this.held.filter((op) => !due.includes(op));
      const applied = due.flatMap((op) => this.applyOp(op));
      this.afterApplied(applied);
    });
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private enqueue(task: () => Promise<void>): void {
    this.work = this.work.then(task).catch((e: unknown) => {
      this.detail = e instanceof Error ? e.message : String(e);
    });
  }

  private setCursor(n: number): void {
    this.cursor = n;
    this.scheduleSave();
  }

  private sink(): TransportSink {
    return {
      entries: (batch) => this.enqueue(() => this.take(batch)),
      presence: (data, origin) => this.enqueue(() => this.takePresence(data, origin)),
      status: (s) => {
        this.phase = s.phase;
        this.detail = s.detail ?? "";
        if (s.phase === "live" && this.ready) void this.publishOutbox();
        this.notify();
      },
      reset: () => this.enqueue(() => this.republish()),
      linksChanged: () => this.notify(),
    };
  }

  private applyOp(op: Op): Applied[] {
    this.clock.observe(op.at);
    if (op.name) this.names.set(op.by, op.name);
    const applied = this.state.apply(op);
    if (op.by !== this.opts.memberId) this.lastChange.set(op.by, this.now());
    return applied;
  }

  private afterApplied(applied: Applied[], local = false): void {
    if (applied.length) this.opts.onApplied?.(applied, local);
    this.scheduleSave();
    this.notify();
  }

  private async take(batch: ReceivedEntry[]): Promise<void> {
    const applied: Applied[] = [];
    for (const entry of batch) {
      const payload = readPayload(await openEntry(this.opts.room, entry.data));
      if (!payload || (entry.origin !== undefined && payload.by !== entry.origin)) {
        this.rejected++;
        continue;
      }
      if (payload.kind === "ops") {
        if (this.state.hasSeen(payload.by, payload.seq)) continue;
        if (this.clock.tooFarAhead(payload.at)) {
          if (!this.held.some((h) => h.by === payload.by && h.seq === payload.seq)) this.held.push(payload);
          if (payload.name) this.names.set(payload.by, payload.name);
          continue;
        }
        applied.push(...this.applyOp(payload));
      } else if (payload.kind === "state") {
        for (const reg of payload.regs) this.clock.observe(reg[3]);
        applied.push(...this.state.applySnapshot(payload));
      } else if (payload.by !== this.opts.memberId) {
        this.presence.set(payload.by, { presence: payload, receivedAt: this.now() });
        if (payload.name) this.names.set(payload.by, payload.name);
      }
    }
    this.afterApplied(applied);
  }

  private async takePresence(data: string, origin?: string): Promise<void> {
    const payload = readPayload(await openEntry(this.opts.room, data));
    if (!payload || payload.kind !== "presence" || (origin !== undefined && payload.by !== origin)) {
      this.rejected++;
      this.notify();
      return;
    }
    if (payload.by === this.opts.memberId) return;
    this.presence.set(payload.by, { presence: payload, receivedAt: this.now() });
    if (payload.name) this.names.set(payload.by, payload.name);
    this.notify();
  }

  private flush(): void {
    if (!this.ready || this.stopped || this.pending.length === 0) return;
    const pending = this.pending;
    this.pending = [];
    this.enqueue(async () => {
      const changes = pending.flatMap((p) => p.changes);
      const fp: Record<string, string> = Object.assign({}, ...pending.map((p) => p.fp));
      const applied: Applied[] = [];
      for (let i = 0; i < changes.length; i += MAX_CHANGES_PER_OP) {
        const ch = changes.slice(i, i + MAX_CHANGES_PER_OP);
        const named = new Set(ch.map((c) => c[0]));
        const op: Op = {
          v: 1,
          kind: "ops",
          by: this.opts.memberId,
          name: this.opts.name(),
          seq: ++this.seq,
          at: this.clock.next(),
          ch,
          fp: Object.fromEntries(Object.entries(fp).filter(([entity]) => named.has(entity))),
        };
        applied.push(...this.state.apply(op));
        this.outbox.push(await sealEntry(this.opts.room, op));
      }
      this.afterApplied(applied, true);
      void this.publishOutbox();
    });
  }

  private async republish(): Promise<void> {
    const regs = this.state.registers();
    const fp = Object.fromEntries(this.state.fingerprints);
    for (let i = 0; i < regs.length; i += MAX_CHANGES_PER_OP) {
      const chunk = regs.slice(i, i + MAX_CHANGES_PER_OP);
      const named = new Set(chunk.map((r) => r[0]));
      this.outbox.push(
        await sealEntry(this.opts.room, {
          v: 1,
          kind: "state",
          by: this.opts.memberId,
          regs: chunk,
          fp: Object.fromEntries(Object.entries(fp).filter(([entity]) => named.has(entity))),
        }),
      );
    }
    this.scheduleSave();
    if (this.ready) void this.publishOutbox();
  }

  private publishOutbox(): Promise<void> {
    if (this.publishing) return this.publishing;
    const transport = this.transport;
    if (!transport || this.outbox.length === 0 || this.stopped) return Promise.resolve();
    this.publishing = (async () => {
      try {
        while (this.outbox.length && !this.stopped) {
          const batch = this.outbox.slice(0, MAX_OUTBOX_BATCH);
          await transport.publish(batch);
          this.outbox.splice(0, batch.length);
          this.scheduleSave();
        }
      } catch (e) {
        this.detail = e instanceof Error ? e.message : String(e);
        this.later(() => void this.publishOutbox(), RETRY_MS);
      } finally {
        this.publishing = null;
        this.notify();
      }
    })();
    return this.publishing;
  }

  private async sendPresence(): Promise<void> {
    if (!this.transport || this.stopped) return;
    const presence: Presence = {
      v: 1,
      kind: "presence",
      by: this.opts.memberId,
      name: this.opts.name(),
      role: this.own.role,
      module: this.own.module,
      photo: this.own.photo,
      editing: this.own.editing,
      wall: this.now(),
      app: this.opts.appVersion ?? "",
    };
    try {
      await this.transport.publishPresence(await sealEntry(this.opts.room, presence));
    } catch {
      /* the next heartbeat tries again */
    }
  }

  private later(task: () => void, ms: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      task();
    }, ms);
    this.timers.add(timer);
  }

  private scheduleSave(): void {
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DELAY_MS);
  }

  /** Keep the room's record now. */
  async save(): Promise<void> {
    const record: RoomRecord = {
      state: this.state.toJSON(),
      cursor: this.cursor,
      outbox: this.outbox,
      seq: this.seq,
      clock: this.clock.lastAt,
    };
    await this.opts.store.save(this.opts.room.roomId, record);
  }
}
