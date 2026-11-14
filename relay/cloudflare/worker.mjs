// Studio Collab relay as a Cloudflare Worker with one Durable Object per room,
// on the studio's own Cloudflare account (the free plan is enough). Sockets
// use the hibernation API, so a quiet room sleeps and costs nothing; presence
// lives in memory and refills from the next heartbeats after a wake.
// Deploy: see the README ("Relay on Cloudflare").

import { errorResponse, handleRoomHttp, handleTopLevel, onSocketMessage, roomAllowed, routeOf } from "../shared/protocol.mjs";
import { Room } from "../shared/room.mjs";

const ENTRY_PREFIX = "e:";
const entryKey = (seq) => `${ENTRY_PREFIX}${String(seq).padStart(12, "0")}`;
const PUT_BATCH = 120;

/** A room store over Durable Object storage. */
export function durableStore(storage) {
  return {
    async load() {
      return (await storage.get("meta")) ?? null;
    },
    async saveMeta(meta) {
      await storage.put("meta", meta);
    },
    async append(list, meta) {
      for (let i = 0; i < list.length; i += PUT_BATCH) {
        const batch = {};
        for (const e of list.slice(i, i + PUT_BATCH)) batch[entryKey(e.seq)] = e.data;
        await storage.put(batch);
      }
      await storage.put("meta", meta);
    },
    async range(after, limit) {
      const found = await storage.list({ prefix: ENTRY_PREFIX, start: entryKey(after + 1), limit });
      return [...found].map(([key, data]) => ({ seq: Number(key.slice(ENTRY_PREFIX.length)), data }));
    },
  };
}

export class RelayRoom {
  /**
   * @param {any} ctx  DurableObjectState
   * @param {any} env
   * @param {{ pair?: () => [any, any], upgrade?: (client: any) => Response }} [platform]
   *   The WebSocketPair and the 101 response, which only exist on Cloudflare;
   *   tests pass stand-ins.
   */
  constructor(ctx, env, platform = {}) {
    this.ctx = ctx;
    this.env = env;
    this.room = new Room(durableStore(ctx.storage));
    this.pair = platform.pair ?? (() => Object.values(new WebSocketPair()));
    this.upgrade = platform.upgrade ?? ((client) => new Response(null, { status: 101, webSocket: client }));
  }

  broadcast(items) {
    for (const { message, except } of items ?? []) {
      const text = JSON.stringify(message);
      for (const socket of this.ctx.getWebSockets()) {
        const session = socket.deserializeAttachment();
        if (session?.authed && session.member !== except) socket.send(text);
      }
    }
  }

  async fetch(request) {
    const route = routeOf(new URL(request.url).pathname);
    if (!route) return errorResponse("bad-request");
    if (route.endpoint === "socket") {
      if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket")
        return errorResponse("bad-request", "Open this address as a WebSocket");
      const [client, server] = this.pair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ authed: false, member: null });
      return this.upgrade(client);
    }
    const result = await handleRoomHttp(request, this.room, route.endpoint);
    this.broadcast(result.broadcast);
    return result.response;
  }

  async webSocketMessage(socket, message) {
    const session = socket.deserializeAttachment() ?? { authed: false, member: null };
    const result = await onSocketMessage(this.room, session, typeof message === "string" ? message : "");
    socket.serializeAttachment(result.session);
    for (const reply of result.replies) socket.send(JSON.stringify(reply));
    this.broadcast(result.broadcast);
    if (result.close) socket.close(1008, "Refused");
  }

  async webSocketClose(socket) {
    try {
      socket.close(1000, "Bye");
    } catch {
      /* already closed */
    }
  }
}

export default {
  async fetch(request, env) {
    const top = handleTopLevel(request);
    if (top) return top;
    const { roomId } = routeOf(new URL(request.url).pathname);
    if (!roomAllowed(roomId, env.ALLOWED_ROOMS)) return errorResponse("not-allowed", "This relay doesn't serve that room");
    return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(request);
  },
};
