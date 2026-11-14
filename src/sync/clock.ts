// Change stamps and the clock that makes them: core's multi-window rule
// (src/project/change-stamps.ts), carried between machines. A stamp is the
// time a change was made by its member's clock and that member's id, which
// orders two changes stamped at the same moment the same way everywhere.

export type ChangeStamp = [at: number, by: string];

/** How far ahead of this computer's clock a stamp may be and still be taken.
 *  Further ahead, its op waits: one machine set to next year would otherwise
 *  win every change for a year. */
export const MAX_FUTURE_MS = 10 * 60_000;

/** Whether `a` is a later change than `b`. A missing stamp is never newer, and
 *  any stamp is newer than none; an equal stamp is the same change. */
export function newer(a: ChangeStamp | undefined, b: ChangeStamp | undefined): boolean {
  if (!a) return false;
  if (!b) return true;
  return a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
}

export function isStamp(value: unknown): value is ChangeStamp {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "string"
  );
}

/** One member's clock: the time, but always past every stamp it made or has
 *  read, so a change made after seeing another's is newer than it whatever the
 *  two wall clocks say. */
export class ChangeClock {
  private last = 0;
  private readonly by: string;
  private readonly now: () => number;

  constructor(by: string, now: () => number = Date.now, last = 0) {
    this.by = by;
    this.now = now;
    this.last = last;
  }

  next(): ChangeStamp {
    this.last = Math.max(this.now(), this.last + 1);
    return [this.last, this.by];
  }

  observe(stamp: ChangeStamp | undefined): void {
    if (stamp && stamp[0] > this.last) this.last = stamp[0];
  }

  tooFarAhead(stamp: ChangeStamp): boolean {
    return stamp[0] > this.now() + MAX_FUTURE_MS;
  }

  get lastAt(): number {
    return this.last;
  }
}
