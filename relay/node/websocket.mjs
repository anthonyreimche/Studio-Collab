// The server side of RFC 6455 WebSocket, text frames only: enough for the
// relay to run on a bare Node install (no packages) or in a small Docker image.

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Finish a WebSocket upgrade on `socket`. Returns a connection, or null after
 * refusing a request that isn't a WebSocket handshake.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:stream").Duplex} socket
 * @param {{ onMessage(text: string): void, onClose(): void }} handlers
 */
export function acceptWebSocket(req, socket, head, handlers) {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  if (upgrade !== "websocket" || typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments = [];
  let fragmentBytes = 0;
  let closed = false;

  const conn = {
    send(text) {
      if (!closed) socket.write(frame(OP_TEXT, Buffer.from(text, "utf8")));
    },
    ping() {
      if (!closed) socket.write(frame(OP_PING, Buffer.alloc(0)));
    },
    close(code = 1000, reason = "") {
      if (closed) return;
      closed = true;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      socket.end(frame(OP_CLOSE, body));
      handlers.onClose();
    },
    get closed() {
      return closed;
    },
  };

  function fail(code) {
    conn.close(code, code === 1009 ? "Message too big" : "Protocol error");
  }

  function parse() {
    while (!closed && buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) return fail(1009);
        len = Number(big);
        at = 10;
      }
      if (!masked) return fail(1002);
      if (len > MAX_MESSAGE_BYTES) return fail(1009);
      if (buffer.length < at + 4 + len) return;
      const mask = buffer.subarray(at, at + 4);
      const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(at + 4 + len);

      if (opcode === OP_CLOSE) {
        conn.close(1000);
        return;
      }
      if (opcode === OP_PING) {
        socket.write(frame(OP_PONG, payload));
        continue;
      }
      if (opcode === OP_PONG) continue;
      if (opcode === OP_BINARY) return fail(1003);
      if (opcode !== OP_TEXT && opcode !== OP_CONTINUATION) return fail(1002);
      if (opcode === OP_TEXT && fragments.length) return fail(1002);
      if (opcode === OP_CONTINUATION && !fragments.length) return fail(1002);
      fragments.push(payload);
      fragmentBytes += payload.length;
      if (fragmentBytes > MAX_MESSAGE_BYTES) return fail(1009);
      if (fin) {
        const text = Buffer.concat(fragments).toString("utf8");
        fragments = [];
        fragmentBytes = 0;
        handlers.onMessage(text);
      }
    }
  }

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    parse();
  });
  socket.on("close", () => {
    if (!closed) {
      closed = true;
      handlers.onClose();
    }
  });
  socket.on("error", () => socket.destroy());
  queueMicrotask(parse);
  return conn;
}
