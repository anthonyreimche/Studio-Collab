// An in-memory medium for engine tests: every member's transport shares one
// list of entries. It can drop a member offline, deliver everything twice, or
// deliver in reverse, the way slow and duplicating sync tools do.

import type { CollabTransport, TransportSink } from "../../src/transport/types";
import type { Cursor } from "../../src/sync/engine";

export class Hub {
  readonly entries: { data: string; origin: string }[] = [];
  readonly transports = new Set<HubTransport>();
  duplicate = false;
  reverse = false;
  /** Entries pushed past this stay unseen until `release`. */
  holding = false;

  transport(member: string, cursor: Cursor): HubTransport {
    const t = new HubTransport(this, member, cursor);
    this.transports.add(t);
    return t;
  }

  deliverAll(): void {
    if (this.holding) return;
    for (const t of this.transports) t.deliver();
  }

  release(): void {
    this.holding = false;
    this.deliverAll();
  }

  /** Forget every entry, as a relay that lost its data. */
  wipe(): void {
    this.entries.length = 0;
    for (const t of this.transports) t.wiped();
  }
}

export class HubTransport implements CollabTransport {
  readonly kind = "hub";
  readonly realtime = true;
  online = true;
  sink: TransportSink | null = null;
  published = 0;

  constructor(
    private readonly hub: Hub,
    readonly member: string,
    private readonly cursor: Cursor,
  ) {}

  async start(sink: TransportSink): Promise<void> {
    this.sink = sink;
    sink.status({ phase: "live" });
    this.deliver();
  }

  async stop(): Promise<void> {
    this.hub.transports.delete(this);
    this.sink = null;
  }

  async publish(entries: string[]): Promise<void> {
    if (!this.online) throw new Error("offline");
    this.published += entries.length;
    this.hub.entries.push(...entries.map((data) => ({ data, origin: this.member })));
    this.hub.deliverAll();
  }

  async publishPresence(entry: string): Promise<void> {
    if (!this.online) throw new Error("offline");
    for (const t of this.hub.transports) if (t !== this) t.sink?.presence(entry, this.member);
  }

  deliver(): void {
    if (!this.online || !this.sink) return;
    const from = this.cursor.get();
    let fresh = this.hub.entries.slice(from);
    if (fresh.length === 0) return;
    this.cursor.set(this.hub.entries.length);
    if (this.hub.reverse) fresh = [...fresh].reverse();
    this.sink.entries(fresh);
    if (this.hub.duplicate) this.sink.entries(fresh);
  }

  wiped(): void {
    if (this.cursor.get() > this.hub.entries.length) {
      this.cursor.set(0);
      this.sink?.reset?.();
    }
  }

  goOnline(): void {
    this.online = true;
    this.sink?.status({ phase: "live" });
    this.deliver();
  }
}
