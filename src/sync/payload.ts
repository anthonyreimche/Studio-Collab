// What an opened entry may hold. Entries come from other computers through
// folders and relays anyone could write to, so each is checked field by field
// before it reaches the merge; one that doesn't fit is dropped.

import { isStamp } from "./clock";
import type { Change, FieldValue, Op, Register4, StateSnapshot } from "./state";

export const ROLES = ["shooter", "culler", "editor", "exporter"] as const;
export type Role = (typeof ROLES)[number];

export interface Presence {
  v: 1;
  kind: "presence";
  by: string;
  name: string;
  /** "" when the member picked none. */
  role: Role | "";
  module: string;
  /** The photo the member is on, or "" for none. */
  photo: string;
  /** On that photo in Develop: the soft lock others see. */
  editing: boolean;
  /** The member's wall clock when it was sent. */
  wall: number;
  app: string;
}

export type Payload = Op | Presence | StateSnapshot;

const ENTITY = /^[pc]:./;
const MAX_TEXT = 512;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown, max = MAX_TEXT): v is string => typeof v === "string" && v.length <= max;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
const isRole = (v: unknown): v is Role => ROLES.some((r) => r === v);

function isFieldValue(v: unknown, depth = 0): v is FieldValue {
  if (depth > 32) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((item) => isFieldValue(item, depth + 1));
  return isRecord(v) && Object.values(v).every((item) => isFieldValue(item, depth + 1));
}

function isChange(v: unknown): v is Change {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    isText(v[0], 2048) &&
    ENTITY.test(v[0]) &&
    isText(v[1]) &&
    v[1] !== "" &&
    isFieldValue(v[2])
  );
}

function isRegister(v: unknown): v is Register4 {
  return Array.isArray(v) && v.length === 4 && isChange(v.slice(0, 3)) && isStamp(v[3]);
}

function readFingerprints(v: unknown): Record<string, string> {
  const fp: Record<string, string> = {};
  if (isRecord(v)) for (const [key, value] of Object.entries(v)) if (isText(value)) fp[key] = value;
  return fp;
}

function readSnapshot(v: Record<string, unknown>, by: string): StateSnapshot | null {
  if (!Array.isArray(v.regs) || !v.regs.every(isRegister)) return null;
  return { v: 1, kind: "state", by, regs: v.regs, fp: readFingerprints(v.fp) };
}

function readOp(v: Record<string, unknown>, by: string): Op | null {
  if (!isCount(v.seq) || !isStamp(v.at) || v.at[1] !== by) return null;
  if (!Array.isArray(v.ch) || !v.ch.every(isChange)) return null;
  return { v: 1, kind: "ops", by, name: isText(v.name, 80) ? v.name : "", seq: v.seq, at: v.at, ch: v.ch, fp: readFingerprints(v.fp) };
}

function readPresence(v: Record<string, unknown>, by: string): Presence | null {
  if (typeof v.wall !== "number" || !Number.isFinite(v.wall)) return null;
  return {
    v: 1,
    kind: "presence",
    by,
    name: isText(v.name, 80) ? v.name : "",
    role: isRole(v.role) ? v.role : "",
    module: isText(v.module, 64) ? v.module : "",
    photo: isText(v.photo, 2048) ? v.photo : "",
    editing: v.editing === true,
    wall: v.wall,
    app: isText(v.app, 32) ? v.app : "",
  };
}

export function readPayload(value: unknown): Payload | null {
  if (!isRecord(value) || value.v !== 1 || !isText(value.by, 64) || value.by === "") return null;
  if (value.kind === "ops") return readOp(value, value.by);
  if (value.kind === "presence") return readPresence(value, value.by);
  if (value.kind === "state") return readSnapshot(value, value.by);
  return null;
}
