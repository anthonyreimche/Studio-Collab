// The shared-folder transport: a folder a sync tool (Google Drive, OneDrive,
// Dropbox, Syncthing, a NAS share) keeps the same on every computer.
//
//   <root>/studio-collab/<roomId>/members/<memberId>/ops-000001.log
//                                                     presence.log
//
// Each member writes only its own folder, so two computers never write one
// file and the sync tool never has to pick a winner. A log only ever grows, a
// line at a time; past a size it is closed and the next one starts with a
// header line ("h1 <n>") saying how many lines the closed one holds, so readers
// know when they have all of it and stop reading it. Readers take only lines
// that end in "\n" (a file still downloading is cut off anywhere), read
// conflicted copies like the original (their lines are mostly duplicates,
// which the engine skips), and skip the sync tools' temp files.

import type { FolderLike } from "./folder-like";
import type { CollabTransport, ReceivedEntry, TransportSink } from "./types";

export interface FolderTransportOptions {
  root: FolderLike;
  roomId: string;
  memberId: string;
  /** Between polls; 0 polls only when asked (tests). */
  pollMs?: number;
  maxSegmentLines?: number;
  maxSegmentBytes?: number;
}

const MEMBER = /^[0-9a-f]{16}$/;
const LOG = /^ops-(\d{6})(.*)\.log$/;
const HEADER = /^h1 (\d+)$/;
const PRESENCE_FILE = "presence.log";
const SIGNAL_FILE = "signal.log";
/** Signals kept in a member's signal file: the latest of each kind is enough. */
const SIGNALS_KEPT = 8;

const segmentName = (n: number) => `ops-${String(n).padStart(6, "0")}.log`;

/** Whether `name` is a log, or a sync tool's copy of one, and not a temp file. */
function logSegment(name: string): number | null {
  if (/^[.~]/.test(name) || /\.tmp$/i.test(name)) return null;
  const m = LOG.exec(name);
  return m ? Number(m[1]) : null;
}

/** The "\n"-terminated lines of `text` and the length they take up. */
function completeLines(text: string): { lines: string[]; length: number } {
  const end = text.lastIndexOf("\n");
  if (end === -1) return { lines: [], length: 0 };
  return { lines: text.slice(0, end).split("\n").map((l) => l.replace(/\r$/, "")), length: end + 1 };
}

interface FileProgress {
  lines: number;
  length: number;
  done: boolean;
}

interface MemberProgress {
  files: Map<string, FileProgress>;
  /** Segment number → how many lines it holds, from the next one's header. */
  closedAt: Map<number, number>;
  presence: string | null;
  signals: Set<string>;
}

export class FolderTransport implements CollabTransport {
  readonly kind = "folder";
  readonly realtime = false;
  private readonly opts: Required<FolderTransportOptions>;
  private sink: TransportSink | null = null;
  private members: FolderLike | null = null;
  private own: FolderLike | null = null;
  private readonly progress = new Map<string, MemberProgress>();
  private segment = 1;
  private segmentText = "";
  private segmentLines = 0;
  private segmentEntries = 0;
  private writes: Promise<void> = Promise.resolve();
  private signals: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling: Promise<void> | null = null;
  private stopped = false;

  constructor(opts: FolderTransportOptions) {
    this.opts = {
      ...opts,
      pollMs: opts.pollMs ?? 1500,
      maxSegmentLines: opts.maxSegmentLines ?? 1000,
      maxSegmentBytes: opts.maxSegmentBytes ?? 256 * 1024,
    };
  }

  async start(sink: TransportSink): Promise<void> {
    this.sink = sink;
    this.stopped = false;
    sink.status({ phase: "connecting" });
    try {
      await this.openOwn();
    } catch (e) {
      sink.status({ phase: "problem", detail: e instanceof Error ? e.message : String(e) });
    }
    await this.poll();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.writes;
  }

  publish(entries: string[]): Promise<void> {
    const write = this.writes.then(() => this.append(entries));
    this.writes = write.catch(() => {});
    return write;
  }

  publishPresence(entry: string): Promise<void> {
    const write = this.writes.then(async () => {
      const own = await this.ownFolder();
      await own.writeText(PRESENCE_FILE, `${entry}\n`);
    });
    this.writes = write.catch(() => {});
    return write;
  }

  publishSignal(blob: string): Promise<void> {
    this.signals = [...this.signals, blob].slice(-SIGNALS_KEPT);
    const text = `${this.signals.join("\n")}\n`;
    const write = this.writes.then(async () => (await this.ownFolder()).writeText(SIGNAL_FILE, text));
    this.writes = write.catch(() => {});
    return write;
  }

  /** Read whatever is new in every member's folder. */
  poll(): Promise<void> {
    if (!this.polling) this.polling = this.readAll().finally(() => (this.polling = null));
    return this.polling;
  }

  private schedule(): void {
    if (this.stopped || this.opts.pollMs <= 0) return;
    this.timer = setTimeout(() => {
      void this.poll().finally(() => this.schedule());
    }, this.opts.pollMs);
  }

  private async membersFolder(): Promise<FolderLike> {
    if (this.members) return this.members;
    const top = await this.opts.root.folder("studio-collab", true);
    const room = await top?.folder(this.opts.roomId, true);
    const members = await room?.folder("members", true);
    if (!members) throw new Error("Couldn't make the room's folder");
    this.members = members;
    return members;
  }

  private async ownFolder(): Promise<FolderLike> {
    if (this.own) return this.own;
    const own = await (await this.membersFolder()).folder(this.opts.memberId, true);
    if (!own) throw new Error("Couldn't make this computer's folder in the room");
    this.own = own;
    return own;
  }

  /** Find where this member's own log ends, to carry on from there. */
  private async openOwn(): Promise<void> {
    const own = await this.ownFolder();
    const segments = (await own.list())
      .filter((e) => e.kind === "file")
      .map((e) => (LOG.exec(e.name)?.[2] === "" ? logSegment(e.name) : null))
      .filter((n): n is number => n !== null);
    this.segment = segments.length ? Math.max(...segments) : 1;
    const { lines } = completeLines((await own.readText(segmentName(this.segment))) ?? "");
    this.segmentText = lines.length ? `${lines.join("\n")}\n` : "";
    this.segmentLines = lines.length;
    this.segmentEntries = lines.filter((l) => !HEADER.test(l)).length;
  }

  private async append(entries: string[]): Promise<void> {
    if (entries.length === 0) return;
    const own = await this.ownFolder();
    for (const entry of entries) {
      const full =
        this.segmentEntries >= this.opts.maxSegmentLines ||
        (this.segmentEntries > 0 && this.segmentText.length + entry.length + 1 > this.opts.maxSegmentBytes);
      if (full) {
        await own.writeText(segmentName(this.segment), this.segmentText);
        const closed = this.segmentLines;
        this.segment++;
        this.segmentText = `h1 ${closed}\n`;
        this.segmentLines = 1;
        this.segmentEntries = 0;
      }
      this.segmentText += `${entry}\n`;
      this.segmentLines++;
      this.segmentEntries++;
    }
    await own.writeText(segmentName(this.segment), this.segmentText);
  }

  private async readAll(): Promise<void> {
    const sink = this.sink;
    if (!sink) return;
    try {
      const members = await this.membersFolder();
      for (const entry of await members.list()) {
        if (entry.kind !== "directory" || !MEMBER.test(entry.name)) continue;
        const folder = await members.folder(entry.name, false);
        if (folder) await this.readMember(entry.name, folder, sink);
      }
      if (!this.stopped) sink.status({ phase: "live" });
    } catch (e) {
      this.members = null;
      this.own = null;
      sink.status({ phase: "problem", detail: e instanceof Error ? e.message : String(e) });
    }
  }

  private async readMember(member: string, folder: FolderLike, sink: TransportSink): Promise<void> {
    const progress = this.progress.get(member) ?? { files: new Map(), closedAt: new Map(), presence: null, signals: new Set() };
    this.progress.set(member, progress);

    const presence = completeLines((await folder.readText(PRESENCE_FILE)) ?? "").lines.at(-1) ?? null;
    if (presence && presence !== progress.presence) {
      progress.presence = presence;
      sink.presence(presence, member);
    }

    if (sink.signal && member !== this.opts.memberId) {
      const lines = completeLines((await folder.readText(SIGNAL_FILE)) ?? "").lines.filter(Boolean);
      for (const line of lines) if (!progress.signals.has(line)) sink.signal(line, member);
      progress.signals = new Set(lines);
    }

    const logs = (await folder.list())
      .filter((e) => e.kind === "file")
      .map((e) => ({ name: e.name, segment: logSegment(e.name) }))
      .filter((e): e is { name: string; segment: number } => e.segment !== null)
      .sort((a, b) => a.segment - b.segment || (a.name < b.name ? -1 : 1));

    for (const log of logs) {
      const file = progress.files.get(log.name) ?? { lines: 0, length: 0, done: false };
      progress.files.set(log.name, file);
      if (file.done) continue;
      const text = await folder.readText(log.name);
      if (text === null) continue;
      if (text.length < file.length) {
        file.lines = 0;
        file.length = 0;
      }
      const { lines, length } = completeLines(text);
      const fresh: ReceivedEntry[] = [];
      for (const line of lines.slice(file.lines)) {
        const header = HEADER.exec(line);
        if (header) progress.closedAt.set(log.segment - 1, Number(header[1]));
        else if (line) fresh.push({ data: line, origin: member });
      }
      file.lines = Math.max(file.lines, lines.length);
      file.length = length;
      if (fresh.length) sink.entries(fresh);
    }

    for (const log of logs) {
      const file = progress.files.get(log.name);
      const closed = progress.closedAt.get(log.segment);
      if (file && closed !== undefined && file.lines >= closed) file.done = true;
    }
  }
}
