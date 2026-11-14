// What every transport is to the engine: something that carries sealed
// entries (opaque strings) between members. A transport never opens an entry,
// never merges and never reads an op; it keeps its own place in the stream.
// A new transport (a cloud drive's API, say) is one more class like these.

export type TransportPhase = "connecting" | "live" | "offline" | "problem";

export interface TransportStatus {
  phase: TransportPhase;
  /** What went wrong, in the transport's words, for "offline" and "problem". */
  detail?: string;
}

export interface ReceivedEntry {
  data: string;
  /** Where it came from, when the transport knows: the member folder it was
   *  read from. The engine checks the entry's author against it. */
  origin?: string;
}

export interface TransportSink {
  entries(batch: ReceivedEntry[]): void;
  presence(data: string, origin?: string): void;
  status(status: TransportStatus): void;
  /** The medium lost what it held (a relay's data was wiped): publish the
   *  whole state again so members who join later still get it. */
  reset?(): void;
  /** A sealed signal for direct connections, from member `origin`. */
  signal?(data: string, origin?: string): void;
  /** The direct connections changed (see CollabTransport.links). */
  linksChanged?(): void;
}

/** A direct connection to one teammate (realtime/mesh.ts). */
export interface TransportLink {
  state: "connecting" | "open";
  rttMs: number | null;
}

export interface CollabTransport {
  readonly kind: string;
  /** Live (a relay socket) or as fast as a sync tool carries files. */
  readonly realtime: boolean;
  /** Resolves once what is already there has been delivered to the sink. */
  start(sink: TransportSink): Promise<void>;
  /** Resolves once the entries are kept by the medium; rejects when they
   *  aren't, and the engine sends them again later. */
  publish(entries: string[]): Promise<void>;
  publishPresence(entry: string): Promise<void>;
  /** Carry a sealed signal to the others, where the medium can. */
  publishSignal?(blob: string): Promise<void>;
  /** The direct connections to teammates, by member id, where there are any. */
  links?(): Record<string, TransportLink>;
  stop(): Promise<void>;
}
