// The room code and the keys it gives. Everything a member needs derives from
// the code with HKDF-SHA-256: the room id the folder and the relay know the
// room by, the AES-256-GCM key every entry is sealed with, and the token the
// relay checks. Each output has its own label, so one tells nothing of another:
// the relay holds the token's hash and can't open a single entry.

import { fromBase64Url, toBase64Url } from "./base64";

const CODE_PREFIX = "slc1-";
const CODE_PATTERN = /^slc1-[A-Za-z0-9_-]{43}$/;
const SALT = new TextEncoder().encode("safelight-studio-collab/1");
const SEALED_PREFIX = "s1.";
const IV_BYTES = 12;

export interface Room {
  roomId: string;
  relayToken: string;
  sealKey: CryptoKey;
}

export function makeRoomCode(): string {
  return CODE_PREFIX + toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The code `text` holds, trimmed, or null when it isn't a room code. */
export function parseRoomCode(text: string): string | null {
  const code = text.trim();
  return CODE_PATTERN.test(code) ? code : null;
}

async function hkdfBits(base: CryptoKey, info: string, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: new TextEncoder().encode(info) },
    base,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function deriveRoom(code: string): Promise<Room> {
  const secret = fromBase64Url(code.slice(CODE_PREFIX.length));
  if (!secret) throw new Error("Not a room code");
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const [id, key, token] = await Promise.all([
    hkdfBits(base, "room-id", 16),
    hkdfBits(base, "seal-key", 32),
    hkdfBits(base, "relay-token", 32),
  ]);
  const sealKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { roomId: hex(id), relayToken: toBase64Url(token), sealKey };
}

const additionalData = (roomId: string) => new TextEncoder().encode(`studio-collab/1/${roomId}`);

/** `value` as JSON, encrypted and authenticated for `room`. */
export async function sealEntry(room: Room, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(room.roomId) },
    room.sealKey,
    plain,
  );
  return `${SEALED_PREFIX}${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

/** What `sealed` holds, or null when it wasn't sealed for `room` with its key,
 *  was changed on the way, or isn't an entry at all. */
export async function openEntry(room: Room, sealed: string): Promise<unknown> {
  if (!sealed.startsWith(SEALED_PREFIX)) return null;
  const [ivText, cipherText, extra] = sealed.slice(SEALED_PREFIX.length).split(".");
  if (extra !== undefined || !ivText || !cipherText) return null;
  const iv = fromBase64Url(ivText);
  const cipher = fromBase64Url(cipherText);
  if (!iv || iv.length !== IV_BYTES || !cipher) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(room.roomId) },
      room.sealKey,
      cipher,
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}
