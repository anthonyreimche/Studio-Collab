// Studio Collab relay for Node 22 or later, with no packages: run it on any
// machine the studio owns, or in Docker (see Dockerfile and the README).
//
//   PORT=8787 DATA_DIR=./data ALLOWED_ROOMS=<id>,<id> node relay/node/server.mjs
//
// Serve it behind HTTPS (a reverse proxy such as Caddy or nginx, or a tunnel):
// Safelight reaches a relay only at an https:// and wss:// address. Rooms are
// kept in memory and appended to DATA_DIR/<roomId>.jsonl, which is read back
// at the next start.

import { createReadStream, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { errorResponse, handleRoomHttp, handleTopLevel, onSocketMessage, roomAllowed, routeOf } from "../shared/protocol.mjs";
import { Room, memoryStore } from "../shared/room.mjs";
import { acceptWebSocket } from "./websocket.mjs";

const HELLO_TIMEOUT_MS = 10_000;
const PING_EVERY_MS = 30_000;

async function readRoomFile(file) {
  let meta = null;
  const entries = [];
  try {
    const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.m) meta = record.m;
      else if (Array.isArray(record.e)) entries.push({ seq: record.e[0], data: record.e[1] });
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return { meta, entries };
}

/**
 * A relay server. `dataDir` null keeps rooms in memory only.
 * @param {{ dataDir?: string | null, allowedRooms?: string, now?: () => number }} [options]
 */
export function createRelayServer({ dataDir = null, allowedRooms = "", now = Date.now } = {}) {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  /** @type {Map<string, Promise<{ room: Room, sockets: Set<{ conn: any, session: any }> }>>} */
  const rooms = new Map();
  const upgraded = new Set();

  function roomFor(roomId) {
    let found = rooms.get(roomId);
    if (!found) {
      found = (async () => {
        const file = dataDir ? join(dataDir, `${roomId}.jsonl`) : null;
        const saved = file ? await readRoomFile(file) : { meta: null, entries: [] };
        const write = (records) => (file ? appendFile(file, records.map((r) => `${JSON.stringify(r)}\n`).join("")) : undefined);
        const store = memoryStore(saved.meta, saved.entries, {
          onMeta: (meta) => write([{ m: meta }]),
          onAppend: (list, meta) => write([...list.map((e) => ({ e: [e.seq, e.data] })), { m: meta }]),
        });
        return { room: new Room(store, now), sockets: new Set() };
      })();
      rooms.set(roomId, found);
    }
    return found;
  }

  function broadcast(entry, items) {
    for (const { message, except } of items ?? []) {
      const text = JSON.stringify(message);
      for (const s of entry.sockets) if (s.session.authed && s.session.member !== except) s.conn.send(text);
    }
  }

  async function handle(req, res) {
    const url = `http://${req.headers.host ?? "relay"}${req.url}`;
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    const request = new Request(url, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])),
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: "half",
    });
    let response = handleTopLevel(request);
    if (!response) {
      const { roomId, endpoint } = routeOf(new URL(url).pathname);
      if (!roomAllowed(roomId, allowedRooms)) response = errorResponse("not-allowed", "This relay doesn't serve that room");
      else if (endpoint === "socket") response = errorResponse("bad-request", "Open this address as a WebSocket");
      else {
        const entry = await roomFor(roomId);
        const result = await handleRoomHttp(request, entry.room, endpoint);
        broadcast(entry, result.broadcast);
        response = result.response;
      }
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "server", message: String(e?.message ?? e) }));
    });
  });

  server.on("upgrade", (req, socket, head) => {
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    const route = routeOf(new URL(`http://relay${req.url}`).pathname);
    if (!route || route.endpoint !== "socket" || !roomAllowed(route.roomId, allowedRooms)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const holder = { conn: null, session: { authed: false, member: null } };
    let queue = Promise.resolve();
    let entryRef = null;
    let pinger = null;
    const conn = acceptWebSocket(req, socket, head, {
      onMessage: (text) => {
        queue = queue.then(async () => {
          const entry = entryRef ?? (entryRef = await roomFor(route.roomId));
          const result = await onSocketMessage(entry.room, holder.session, text);
          holder.session = result.session;
          for (const reply of result.replies) holder.conn?.send(JSON.stringify(reply));
          broadcast(entry, result.broadcast);
          if (result.close) holder.conn?.close(1008, "Refused");
        });
      },
      onClose: () => {
        clearTimeout(helloTimer);
        clearInterval(pinger);
        entryRef?.sockets.delete(holder);
        void roomFor(route.roomId).then((entry) => entry.sockets.delete(holder));
      },
    });
    if (!conn) return;
    holder.conn = conn;
    void roomFor(route.roomId).then((entry) => {
      if (!conn.closed) entry.sockets.add(holder);
    });
    const helloTimer = setTimeout(() => {
      if (!holder.session.authed) conn.close(1008, "Say hello first");
    }, HELLO_TIMEOUT_MS);
    pinger = setInterval(() => conn.ping(), PING_EVERY_MS);
  });

  return {
    server,
    listen(port = 0, host) {
      return new Promise((done) => server.listen(port, host, () => done(server.address().port)));
    },
    close() {
      return new Promise((done) => {
        for (const socket of upgraded) socket.destroy();
        server.closeAllConnections?.();
        server.close(() => done());
      });
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const relay = createRelayServer({
    dataDir: resolve(process.env.DATA_DIR ?? "./data"),
    allowedRooms: process.env.ALLOWED_ROOMS ?? "",
  });
  const port = await relay.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? "0.0.0.0");
  console.log(`Studio Collab relay listening on port ${port}`);
}
