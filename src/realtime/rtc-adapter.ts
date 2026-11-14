// The mesh's narrow view of a WebRTC connection, made from any
// RTCPeerConnection: the browser's in Safelight, node-datachannel's in tests.
// Both deliver plain Events; the parts the mesh reads (a message's data, a
// new channel) are checked as they come.

import type { DataChannelLike, PeerConnectionLike, SessionDescriptionLike } from "./mesh";

interface EventTargetLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
}

export interface RawChannel extends EventTargetLike {
  readonly readyState: string;
  send(data: string): void;
  close(): void;
}

export interface RawPeer extends EventTargetLike {
  readonly localDescription: SessionDescriptionLike | null;
  readonly iceGatheringState: string;
  readonly connectionState: string;
  createDataChannel(label: string, init?: { ordered?: boolean }): RawChannel;
  createOffer(): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(description?: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  close(): void;
}

function isRawChannel(v: unknown): v is RawChannel {
  return (
    typeof v === "object" &&
    v !== null &&
    "send" in v &&
    "close" in v &&
    "addEventListener" in v &&
    "readyState" in v &&
    typeof v.send === "function" &&
    typeof v.addEventListener === "function"
  );
}

function adaptChannel(raw: RawChannel): DataChannelLike {
  return {
    get readyState() {
      return raw.readyState;
    },
    send: (data) => raw.send(data),
    close: () => raw.close(),
    on: (type, listener) => raw.addEventListener(type, () => listener()),
    onMessage: (listener) => raw.addEventListener("message", (event) => listener("data" in event ? event.data : undefined)),
  };
}

export function adaptPeer(raw: RawPeer): PeerConnectionLike {
  return {
    get localDescription() {
      return raw.localDescription;
    },
    get iceGatheringState() {
      return raw.iceGatheringState;
    },
    get connectionState() {
      return raw.connectionState;
    },
    createDataChannel: (label, init) => adaptChannel(raw.createDataChannel(label, init)),
    createOffer: () => raw.createOffer(),
    createAnswer: () => raw.createAnswer(),
    setLocalDescription: (d) => raw.setLocalDescription(d),
    setRemoteDescription: (d) => raw.setRemoteDescription(d),
    close: () => raw.close(),
    on: (type, listener) => raw.addEventListener(type, () => listener()),
    onChannel: (listener) =>
      raw.addEventListener("datachannel", (event) => {
        const channel = "channel" in event ? event.channel : null;
        if (isRawChannel(channel)) listener(adaptChannel(channel));
      }),
  };
}
