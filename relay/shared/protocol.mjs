// Studio Collab relay protocol 1, over a WebSocket and over HTTPS, written
// against the web-standard Request and Response so the Node server and the
// Cloudflare Worker share it. Neither reads an entry: they arrive sealed.

import { LIMITS, PROTOCOL, validMember } from "./room.mjs";

const ROOM_PATH = /^\/v1\/rooms\/([0-9a-f]{32})\/(socket|entries|presence)$/;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "86400",
};

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });
}

const STATUS_OF = { auth: 401, "not-allowed": 403, "bad-request": 400, "too-large": 413, "room-full": 507 };

export const errorResponse = (code, message = code) => json({ error: code, message }, STATUS_OF[code] ?? 400);

/** The room and the endpoint a path names, or null. */
export function routeOf(pathname) {
  const m = ROOM_PATH.exec(pathname);
  return m ? { roomId: m[1], endpoint: m[2] } : null;
}

/** Whether `roomId` may be used on a relay locked to `allowed` (a
 *  comma-separated list; empty or missing allows every room). */
export function roomAllowed(roomId, allowed) {
  const list = String(allowed ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length === 0 || list.includes(roomId);
}

/** Answers that don't need a room: health, CORS preflight, unknown paths. */
export function handleTopLevel(request) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (url.pathname === "/v1/health") return json({ ok: true, protocol: PROTOCOL });
  if (!routeOf(url.pathname)) return json({ error: "not-found" }, 404);
  return null;
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) return { error: "too-large" };
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return { error: "too-large" };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: "bad-request" };
  }
}

const bearer = (request) => /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";

/**
 * An HTTPS request to a room's `entries` or `presence` endpoint. Resolves with
 * the response and what to pass on to the room's sockets.
 * @param {Request} request
 * @param {import("./room.mjs").Room} room
 */
export async function handleRoomHttp(request, room, endpoint) {
  if (!(await room.authorize(bearer(request)))) return { response: errorResponse("auth", "This room needs its own token") };
  const url = new URL(request.url);
  if (endpoint === "entries" && request.method === "GET") {
    const after = Number(url.searchParams.get("after") ?? 0);
    const wait = Number(url.searchParams.get("wait") ?? 0) * 1000;
    const page = await room.waitSince(Number.isInteger(after) ? after : 0, wait);
    return {
      response: json({ head: page.head, now: room.now(), entries: page.entries, more: page.more, presence: room.presenceList() }),
    };
  }
  if (request.method !== "POST") return { response: json({ error: "not-found" }, 404) };
  const body = await readJson(request);
  if (body.error) return { response: errorResponse(body.error) };
  if (endpoint === "entries") {
    const result = await room.push(body.value?.entries);
    if (result.error) return { response: errorResponse(result.error) };
    return {
      response: json({ seqs: result.seqs, head: result.head }),
      broadcast: [{ message: { type: "entries", entries: result.entries, head: result.head } }],
    };
  }
  const member = body.value?.member;
  const data = body.value?.data;
  if (!room.setPresence(member, data)) return { response: errorResponse("bad-request") };
  return { response: json({ ok: true }), broadcast: [{ message: { type: "presence", member, data }, except: member }] };
}

/**
 * One text frame from a socket. `session` is what the socket carries between
 * frames ({ authed, member }); the result says what to send back, what to send
 * the room's signed-in sockets (`except` names a member to leave out; the
 * sender gets its own entries back, which moves its place in the stream), and
 * whether to close.
 * @param {import("./room.mjs").Room} room
 */
export async function onSocketMessage(room, session, text) {
  let msg;
  try {
    msg = typeof text === "string" && text.length <= MAX_BODY_BYTES ? JSON.parse(text) : null;
  } catch {
    msg = null;
  }
  const fail = (code, message) => ({
    session,
    replies: [{ type: "error", code, message }],
    broadcast: [],
    close: true,
  });
  if (!msg || typeof msg.type !== "string") return fail("bad-request", "Not a message");

  if (!session.authed) {
    if (msg.type !== "hello") return fail("auth", "Say hello first");
    if (!(await room.authorize(msg.token))) return fail("auth", "This room needs its own token");
    if (!validMember(msg.member)) return fail("bad-request", "Not a member id");
    const replies = [{ type: "welcome", head: room.head, now: room.now(), protocol: PROTOCOL }];
    let after = Number.isInteger(msg.after) && msg.after > 0 ? msg.after : 0;
    if (after > room.head) {
      replies.push({ type: "reset", head: room.head });
      after = 0;
    }
    for (;;) {
      const page = await room.since(after);
      if (page.entries.length) {
        replies.push({ type: "entries", entries: page.entries, head: page.head });
        after = page.entries[page.entries.length - 1].seq;
      }
      if (!page.more && after >= room.head) break;
    }
    for (const p of room.presenceList())
      if (p.member !== msg.member) replies.push({ type: "presence", member: p.member, data: p.data });
    return { session: { authed: true, member: msg.member }, replies, broadcast: [] };
  }

  if (msg.type === "ping") return { session, replies: [{ type: "pong", now: room.now() }], broadcast: [] };
  if (msg.type === "presence") {
    if (!room.setPresence(session.member, msg.data)) return { session, replies: [], broadcast: [] };
    return {
      session,
      replies: [],
      broadcast: [{ message: { type: "presence", member: session.member, data: msg.data }, except: session.member }],
    };
  }
  if (msg.type === "signal") {
    if (typeof msg.data !== "string" || msg.data.length > 64 * 1024) return { session, replies: [], broadcast: [] };
    return {
      session,
      replies: [],
      broadcast: [{ message: { type: "signal", member: session.member, data: msg.data }, except: session.member }],
    };
  }
  if (msg.type === "push") {
    const result = await room.push(msg.entries);
    if (result.error) return { session, replies: [{ type: "error", code: result.error, ref: msg.ref }], broadcast: [] };
    return {
      session,
      replies: [{ type: "ack", ref: msg.ref, seqs: result.seqs }],
      broadcast: [{ message: { type: "entries", entries: result.entries, head: result.head } }],
    };
  }
  return { session, replies: [{ type: "error", code: "bad-request", message: `Unknown message ${msg.type}` }], broadcast: [] };
}

export { LIMITS };
