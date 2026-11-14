// The merge rule: per-field last writer wins, ordered by change stamps that a
// hybrid clock makes. Any delivery order, any number of deliveries, the same
// state.

import { describe, expect, it } from "vitest";
import { ChangeClock, MAX_FUTURE_MS, newer, type ChangeStamp } from "../src/sync/clock";
import { RoomState, type Op } from "../src/sync/state";

const op = (by: string, seq: number, at: number, ch: Op["ch"]): Op => ({
  v: 1,
  kind: "ops",
  by,
  name: by,
  seq,
  at: [at, by],
  ch,
  fp: {},
});

const P = "p:Day 1/IMG_0042.CR3";

function stateOf(ops: Op[]): RoomState {
  const s = new RoomState();
  for (const o of ops) s.apply(o);
  return s;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

describe("newer", () => {
  it("orders by time, then by member id, and counts a missing stamp as oldest", () => {
    expect(newer([2, "a"], [1, "z"])).toBe(true);
    expect(newer([1, "b"], [1, "a"])).toBe(true);
    expect(newer([1, "a"], [1, "a"])).toBe(false);
    expect(newer([1, "a"], undefined)).toBe(true);
    expect(newer(undefined, [1, "a"])).toBe(false);
  });
});

describe("ChangeClock", () => {
  it("never goes backwards, even when the wall clock does", () => {
    let wall = 1000;
    const clock = new ChangeClock("me", () => wall);
    const a = clock.next();
    wall = 500;
    const b = clock.next();
    expect(newer(b, a)).toBe(true);
  });

  it("moves past every stamp it observes, so a later change wins over one it has seen", () => {
    const clock = new ChangeClock("slow", () => 1000);
    const seen: ChangeStamp = [5000, "fast"];
    clock.observe(seen);
    expect(newer(clock.next(), seen)).toBe(true);
  });

  it("says a stamp too far ahead of the wall clock is in the future", () => {
    const clock = new ChangeClock("me", () => 10_000);
    expect(clock.tooFarAhead([10_000 + MAX_FUTURE_MS, "x"])).toBe(false);
    expect(clock.tooFarAhead([10_000 + MAX_FUTURE_MS + 1, "x"])).toBe(true);
  });
});

describe("RoomState", () => {
  it("keeps the newer of two concurrent edits to one field", () => {
    const a = op("ana", 1, 100, [[P, "rating", 3]]);
    const b = op("ben", 1, 101, [[P, "rating", 5]]);
    expect(stateOf([a, b]).value(P, "rating")).toBe(5);
    expect(stateOf([b, a]).value(P, "rating")).toBe(5);
  });

  it("breaks a tie in time by member id, the same way everywhere", () => {
    const a = op("ana", 1, 100, [[P, "flag", "pick"]]);
    const b = op("ben", 1, 100, [[P, "flag", "reject"]]);
    expect(stateOf([a, b]).value(P, "flag")).toBe("reject");
    expect(stateOf([b, a]).value(P, "flag")).toBe("reject");
  });

  it("keeps concurrent edits to different fields", () => {
    const a = op("ana", 1, 100, [[P, "e/p/exposure", 0.7]]);
    const b = op("ben", 1, 100, [[P, "e/p/temperature", 5200]]);
    const s = stateOf([a, b]);
    expect(s.value(P, "e/p/exposure")).toBe(0.7);
    expect(s.value(P, "e/p/temperature")).toBe(5200);
  });

  it("keeps two keywords added at once by two people", () => {
    const s = stateOf([op("ana", 1, 100, [[P, "kw/bride", true]]), op("ben", 1, 100, [[P, "kw/cake", true]])]);
    expect(s.value(P, "kw/bride")).toBe(true);
    expect(s.value(P, "kw/cake")).toBe(true);
  });

  it("reaches the same state from every delivery order", () => {
    const ops = [
      op("ana", 1, 100, [[P, "rating", 2], [P, "kw/a", true]]),
      op("ben", 1, 105, [[P, "rating", 4]]),
      op("ana", 2, 103, [[P, "kw/a", false], [P, "label", "red"]]),
      op("cy", 1, 105, [[P, "rating", 1], [P, "label", "blue"]]),
    ];
    const expected = stateOf(ops).toJSON();
    for (const order of permutations(ops)) expect(stateOf(order).toJSON()).toEqual(expected);
  });

  it("ignores an op delivered twice, and an old op delivered late", () => {
    const first = op("ana", 1, 100, [[P, "rating", 2]]);
    const later = op("ana", 2, 200, [[P, "rating", 4]]);
    const s = stateOf([first, later, first, later]);
    expect(s.value(P, "rating")).toBe(4);
    expect(s.apply(first)).toEqual([]);
    expect(s.hasSeen("ana", 1)).toBe(true);
  });

  it("reports the fields each op changed, for the catalogue to take on", () => {
    const s = new RoomState();
    expect(s.apply(op("ana", 1, 100, [[P, "rating", 2]]))).toEqual([{ entity: P, field: "rating", value: 2 }]);
    expect(s.apply(op("ben", 1, 50, [[P, "rating", 5]]))).toEqual([]);
  });

  it("survives a round trip through JSON", () => {
    const s = stateOf([op("ana", 1, 100, [[P, "rating", 2]]), op("ana", 3, 120, [["c:x", "name", "Selects"]])]);
    const back = RoomState.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
    expect(back.value(P, "rating")).toBe(2);
    expect(back.value("c:x", "name")).toBe("Selects");
    expect(back.hasSeen("ana", 1)).toBe(true);
    expect(back.hasSeen("ana", 2)).toBe(false);
    expect(back.hasSeen("ana", 3)).toBe(true);
  });

  it("lists an entity's fields under a prefix", () => {
    const s = stateOf([op("ana", 1, 100, [[P, "kw/a", true], [P, "kw/b", false], [P, "rating", 1]])]);
    expect(s.fields(P, "kw/")).toEqual({ "kw/a": true, "kw/b": false });
  });

  it("takes a snapshot of another member's state as a merge, keeping what is newer here", () => {
    const theirs = stateOf([op("ana", 1, 100, [[P, "rating", 2], [P, "label", "red"]])]);
    const mine = stateOf([op("ben", 1, 150, [[P, "rating", 5]])]);
    const applied = mine.applySnapshot({ v: 1, kind: "state", by: "ana", regs: theirs.registers(), fp: { [P]: "x" } });
    expect(applied).toEqual([{ entity: P, field: "label", value: "red" }]);
    expect(mine.value(P, "rating")).toBe(5);
    expect(mine.fingerprints.get(P)).toBe("x");
  });
});
