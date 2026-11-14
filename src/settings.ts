// What Studio Collab keeps in its settings on each computer: who you are, the
// room you are in and how it is reached, and this computer's member id in
// each room. Values written by an older or newer version, or by hand, are read
// field by field; a value that doesn't fit counts as unset.

import { parseRoomCode } from "./crypto/room";
import { ROLES, type Role } from "./sync/payload";

export const EXTENSION_ID = "studio-collab";

export const PROFILE_KEY = "profile";
export const ROOM_KEY = "room";
export const MEMBERS_KEY = "members";
export const AUTO_STAGE_KEY = "autoStage";
export const REALTIME_KEY = "realtime";

export interface TurnServer {
  url: string;
  username: string;
  credential: string;
}

/** How direct connections are set up. */
export interface RealtimeSettings {
  /** Find teammates through public Nostr relays and WebTorrent trackers. */
  publicSignalling: boolean;
  /** A TURN server the studio has, for networks that block direct routes. */
  turn: TurnServer | null;
}

export interface Profile {
  name: string;
  role: Role | "";
}

/** Where a room's code is kept: in the settings (`code`), or, where Safelight
 *  has a keychain (api.secrets), there under CODE_SECRET with `code` empty. */
interface RoomCodeHome {
  code: string;
  keychain: boolean;
  project: string;
}

export type RoomConfig = RoomCodeHome &
  ({ transport: "folder"; folderToken: string; folderLabel: string } | { transport: "relay"; relayUrl: string });

export const CODE_SECRET = "room-code";

export interface SettingsStore {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const isRole = (v: unknown): v is Role => ROLES.some((r) => r === v);

export function readProfile(settings: SettingsStore): Profile {
  const v = settings.get<unknown>(PROFILE_KEY, null);
  if (!isRecord(v)) return { name: "", role: "" };
  return { name: text(v.name).slice(0, 80), role: isRole(v.role) ? v.role : "" };
}

export function writeProfile(settings: SettingsStore, profile: Profile): void {
  settings.set(PROFILE_KEY, { name: profile.name.slice(0, 80), role: profile.role });
}

/** The relay address `input` names: an https origin with any path, without a
 *  trailing slash; null for anything else. */
export function relayAddress(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The secure WebSocket origin of a relay address. */
export const socketOrigin = (relayUrl: string): string => new URL(relayUrl).origin.replace(/^https:/, "wss:");

export function readRoom(settings: SettingsStore): RoomConfig | null {
  const v = settings.get<unknown>(ROOM_KEY, null);
  if (!isRecord(v)) return null;
  const keychain = v.keychain === true;
  const code = keychain ? "" : parseRoomCode(text(v.code));
  if (code === null) return null;
  const home = { code, keychain, project: text(v.project) };
  if (v.transport === "folder" && text(v.folderToken))
    return { ...home, transport: "folder", folderToken: text(v.folderToken), folderLabel: text(v.folderLabel) };
  const relayUrl = relayAddress(text(v.relayUrl));
  if (v.transport === "relay" && relayUrl) return { ...home, transport: "relay", relayUrl };
  return null;
}

export function writeRoom(settings: SettingsStore, room: RoomConfig | null): void {
  settings.set(ROOM_KEY, room);
}

/** This computer's member id in the room, made the first time it is asked. */
export function memberIdFor(settings: SettingsStore, roomId: string): string {
  const raw = settings.get<unknown>(MEMBERS_KEY, {});
  const members: Record<string, string> = {};
  if (isRecord(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && /^[0-9a-f]{16}$/.test(v)) members[k] = v;
  const held = members[roomId];
  if (held) return held;
  const made = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
  settings.set(MEMBERS_KEY, { ...members, [roomId]: made });
  return made;
}

export const readAutoStage = (settings: SettingsStore): boolean => settings.get<unknown>(AUTO_STAGE_KEY, true) !== false;

/** A `turn:` or `turns:` address, or null. */
export function turnAddress(input: string): string | null {
  const url = input.trim();
  return /^turns?:[^\s'"]+$/i.test(url) ? url : null;
}

export function readRealtime(settings: SettingsStore): RealtimeSettings {
  const v = settings.get<unknown>(REALTIME_KEY, null);
  if (!isRecord(v)) return { publicSignalling: true, turn: null };
  const t = isRecord(v.turn) ? v.turn : null;
  const url = t ? turnAddress(text(t.url)) : null;
  return {
    publicSignalling: v.publicSignalling !== false,
    turn: t && url ? { url, username: text(t.username), credential: text(t.credential) } : null,
  };
}

export function writeRealtime(settings: SettingsStore, value: RealtimeSettings): void {
  settings.set(REALTIME_KEY, value);
}
