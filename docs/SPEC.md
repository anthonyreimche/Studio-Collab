# Studio Collab: specification

Issue: anthonyreimche/SafeLight#204, "websocket realtime collab for studio
teams". A studio splits shooting, culling, editing and export between people.
Studio Collab keeps their Safelight catalogues in step: ratings, flags, colour
labels, keywords, develop edits, team collections, and who is working on what.

Constraints: Safelight pays for no server, and the studio hosts nothing it
doesn't want to. Changes should show on a teammate's screen within about a
second (Anthony, on 1.0.0: "I expect almost immediate changes, not 2 or 3
minutes"). So teammates connect to each other directly (WebRTC data
channels, section 6.4), find each other through free public signalling
(Nostr relays, WebTorrent trackers) or the studio's own paths, and keep a
shared folder or a self-hosted relay as the lasting record and the way to
catch up.

Version 1.0.0. Extension id `studio-collab`. Needs Safelight 3.2.4 (kept
folders, `api.network`); live relay sockets need the `api.sockets` seam
described in section 8, and are feature-detected.

## 1. Overview

```
 Safelight (each member)                         shared medium
 ┌──────────────────────────────────────┐
 │ catalogue ⇄ CatalogPort ⇄ Engine     │        ┌─────────────────────────┐
 │                     │  merge (LWW)   │  seal  │ Shared folder (Drive,   │
 │                     ▼                │ ─────▶ │ OneDrive, Dropbox, NAS, │
 │              RoomState ◀── open ──── │ ◀───── │ Syncthing)              │
 │                     │                │        ├─────────────────────────┤
 │                Transport (opaque     │        │ Relay (Node / Docker,   │
 │                sealed strings only)  │        │ Cloudflare Worker + DO) │
 └──────────────────────────────────────┘        └─────────────────────────┘
```

- The **engine** turns catalogue changes into ops, merges ops from everyone
  into one state, and writes the winning values back into the catalogue.
- Every op is **sealed** (AES-256-GCM) with a key derived from the room code
  before it reaches a transport. Transports carry opaque strings and never see
  plaintext, so a new transport (a cloud API, Immich) adds no trust.
- The merge is a last-writer-wins map keyed by (entity, field), ordered by a
  hybrid logical clock. It is a state CRDT: applying ops in any order, any
  number of times, gives the same state. That is what lets slow, duplicating,
  reordering media such as cloud sync folders work at all, and lets the same
  entry arrive twice (directly and through the folder) without harm.
- **Direct connections** (section 6.4) sit on top of the durable transport:
  every entry goes down each open data channel at once and to the durable
  transport as well. Measured in-process over real WebRTC on loopback: a
  change recorded on one engine is merged by the other's in about 113 ms,
  100 ms of which is the engine batching keystrokes; the channel itself
  carries an entry in under 1 ms, round trip 11 ms.

## 2. Photo identity

A photo is matched across machines by its **path relative to the shared photo
root**, with a fingerprint to relink it when paths differ.

- Key: `p:` + the photo's `relPath` in the open project, Unicode NFC, `/`
  separators. A virtual copy appends `#copy:<copyName>`.
- Fingerprint: `filename|fileSize|exif.dateTimeOriginal|exif.subSecTimeOriginal`.
  Every op that names a photo carries its fingerprint.
- Relink: an incoming key with no local photo is matched to the one local
  photo with the same fingerprint, if exactly one has it. The alias is kept for
  the session. Two members who opened the shared tree at different levels
  (`Shoots/` against `Shoots/2026-11-wedding/`) still meet this way.

Why a path and not a content hash:

1. **Cost.** A content hash reads every byte of every photo. On a NAS that is
   gigabytes over the network per shoot; on Google Drive or OneDrive with
   files-on-demand it forces every RAW to download to every machine. The path
   is already in the catalogue.
2. **Availability.** A member can rate a photo whose bytes their sync client
   hasn't pulled yet.
3. **It is what people see.** "IMG_0042.CR3 in Day 1" is debuggable; a hash
   is not.
4. **Uniqueness.** Two identical files in two folders are two photos to the
   team (different selects, different crops). A hash would merge them.

What the path costs, and how it is covered: a rename or move on one machine
changes the key. The fingerprint relink finds the photo again on the others as
long as the name, size and capture time are unchanged, which is the case for a
move. A rename starts the photo afresh under its new key (its old state stays
under the old key); section 12 lists this.

## 3. What is synced

Entities are keyed `p:<path>` (photos) and `c:<id>` (team collections). Each
entity holds fields; each field is one last-writer-wins register.

| Field | Value | Notes |
|---|---|---|
| `rating` | 0 to 5 | |
| `flag` | `none`, `pick`, `reject` | |
| `label` | `none`, `red`, `yellow`, `green`, `blue`, `purple` | |
| `kw/<keyword>` | boolean | One register per keyword, so two people adding different keywords at once both keep theirs. |
| `stage` | `shot`, `culled`, `edited`, `exported` | Advanced automatically (below) or set by hand. |
| `col/<collectionId>` | boolean | Membership in a team collection. |
| `e/p/<param>` | JSON | One register per top-level develop parameter. |
| `e/b/<key>` | JSON | One register per extension stage parameter (`paramBag`). |
| `name` (on `c:`) | string | Team collection name. |
| `deleted` (on `c:`) | boolean | Team collection tombstone. |

Develop edits merge per parameter: Ana on exposure and Ben on white balance
both keep their changes. A parameter that is a whole structure (the mask list,
the crop) is one value. Each member's own undo history stays local: a remote
edit lands as one new history step named "Studio Collab: <name>".

Stage rules, on by default (Panel ▸ "Advance stages automatically"):

- a rating, flag or label set on a photo at `shot` moves it to `culled`;
- a develop edit on a photo before `edited` moves it to `edited`;
- an export moves it to `exported` (through an export processor that returns
  the image untouched).

Collections: Safelight's Collections extension keeps its collections in its
own private settings, keyed by local photo ids, so another extension can't
read or write them. Studio Collab keeps **team collections** of its own
(create, rename, delete, add or remove the selected photos, show one in the
grid through a grid filter). Section 13 proposes the contract that would let
Collections share its collections instead.

Not synced: rotation, stacks, virtual copy creation, file operations (the
shared drive already carries them), presets, and photos outside the room.

## 4. Merge rule

The rule is core's multi-window rule (`src/project/change-stamps.ts`): a
change stamp is `[at, by]`; `newer(a, b)` compares `at`, then `by`; a missing
stamp is the oldest. Studio Collab carries the same clock (`ChangeClock`): the
next stamp is `max(now, last + 1)`, and the clock observes every stamp it
reads, so a change made after seeing another is always newer than it, whatever
the two wall clocks say.

- `by` is the member id (random, per install and room), so ties order the
  same way everywhere.
- One stamp per op: all changes in one op share it.
- Applying an op: for each change, take it if its stamp is newer than the
  field's. Applying the same op twice, or ops in another order, gives the same
  state (tests pin commutativity, idempotence and out-of-order delivery).

Clock skew. Within a few minutes, the clock does what core's does: causally
later changes win. Past `MAX_FUTURE_MS` (10 minutes ahead of the receiver's
wall clock) an op is **held**, not applied, and the panel says whose clock is
ahead and by how much. A held op is applied once the receiver's clock is within
the limit. This stops one machine set to next year from winning every change
for a year, at the cost of delaying that machine's changes until its clock is
fixed. Presence carries each member's wall clock, so skew is shown before it
bites.

Echo. The engine writes a winning remote value into the catalogue; the
catalogue then reports a change. The engine compares catalogue values with the
merged state and makes an op only where they differ, so applied values never
come back as new ops.

Joining. On the first connection of a member to a room, after catch-up:

- a field the room has a value for: the room's value wins locally;
- a field the room has none for, where the local value is not the default:
  the member publishes it ("seeding").

Later, the same diff runs after every catalogue change.

## 5. Ops and entries

Plaintext op (JSON):

```json
{
  "v": 1,
  "kind": "ops",
  "by": "8f3c1a2b9d4e5f60",
  "name": "Ana",
  "seq": 42,
  "at": [1763060000123, "8f3c1a2b9d4e5f60"],
  "ch": [["p:Day 1/IMG_0042.CR3", "rating", 4], ["p:Day 1/IMG_0042.CR3", "kw/bride", true]],
  "fp": { "p:Day 1/IMG_0042.CR3": "IMG_0042.CR3|31457280|2026:11:01 10:00:00|12" }
}
```

- `seq` counts each member's ops from 1; `(by, seq)` is the op id, used to
  skip duplicates cheaply. The merge would be right without it.
- An op holds at most 400 changes and seals to at most 256 KiB; a bigger
  change set is split.

Other kinds: `presence` (section 7) and `state`, a member's whole merged
state as registers with their original stamps (`regs: [entity, field, value,
[at, by]][]`). A member publishes `state` entries when a relay says it lost its
entries; taking one is a merge like any op's.

Sealed entry: `s1.<iv>.<ciphertext>`, base64url, AES-256-GCM with a 96-bit
random IV; additional data `studio-collab/1/<roomId>`, so an entry can't be
replayed into another room. A line that doesn't open is counted as rejected
and skipped; it never stops the rest.

## 6. Transports

### 6.1 Interface

```ts
interface CollabTransport {
  readonly kind: string;            // "folder", "relay", later "gdrive", ...
  readonly realtime: boolean;       // shown in the UI: seconds-to-minutes vs live
  start(sink: TransportSink): Promise<void>;
  publish(entries: string[]): Promise<void>;  // resolves once durable
  publishPresence(entry: string): Promise<void>;
  publishSignal?(blob: string): Promise<void>;   // carry a sealed signal, where it can
  links?(): Record<string, { state: "connecting" | "open"; rttMs: number | null }>;
  stop(): Promise<void>;
}
interface TransportSink {
  entries(batch: { data: string; origin?: string }[]): void;
  presence(data: string, origin?: string): void;
  status(s: TransportStatus): void; // phase, lastHeard, detail
  reset?(): void;                   // the medium lost its entries
  signal?(blob: string, origin?: string): void;
  linksChanged?(): void;
}
```

A transport moves opaque strings and keeps its own resume cursor. It never
merges, never decrypts and never interprets ops. `publish` may reject (offline);
the engine keeps unsent entries in its outbox and retries. Adding a transport
means adding one class and one setup form; the engine, merge and UI don't
change.

### 6.2 Shared folder (default)

The team picks a folder their sync tool already shares: a Google Drive shared
drive, OneDrive or SharePoint, Dropbox, Syncthing, or an SMB/NAS share. It is
kept with `api.project.pickKeptDirectory`, so no OAuth and no network
permission are needed, and every provider works the same way.

Layout:

```
<picked folder>/studio-collab/<roomId>/members/<memberId>/
    ops-000001.log      sealed entries, one per line, "\n"-terminated
    ops-000002.log      ...
    presence.log        one sealed presence line, rewritten in place
    signal.log          the member's latest 8 sealed signals (section 6.4)
```

Rules that make cloud sync safe:

1. **Each member writes only files in its own folder**, so two machines never
   write one file and the sync tool never has to choose. Member ids are per
   install, so one person on two computers is two members.
2. **Append-only segments.** A segment is rewritten only to add lines (the
   desktop folder handle has no append; segments are capped at 256 KiB or 1000
   entries, so the rewrite stays cheap). Segment `n+1` starts with a header line
   `h1 <lines>` saying how many lines segment `n` holds, so a reader knows when
   an older segment is complete and never reads it again. The header is the
   transport's own and isn't sealed: a forged one can only make a reader stop
   reading a segment early, which someone who can write the folder can do
   anyway by deleting it.
3. **Readers tolerate everything a sync tool does:**
   - a file that arrives late or out of order: the merge doesn't care;
   - a truncated last line (a file mid-download): only `\n`-terminated lines
     are read; the tail waits for the next poll;
   - a file that shrinks (replaced): read again from the start; duplicates are
     skipped;
   - conflicted copies (`ops-000003 (conflicted copy 2026-11-12).log`,
     `ops-000003 (1).log`, `ops-000003-DESKTOP-4F2.log`,
     `ops-000003.sync-conflict-20261112-101010-ABCDEFG.log`): read like the
     original; their entries are mostly duplicates and any extra ones are
     real ops worth keeping;
   - sync temp files (`.~*`, `*.tmp`, `~$*`, dot files): ignored;
   - entries that don't open with the room key, or whose `by` isn't the
     folder's member: rejected and counted.
4. **Polling.** Core offers extensions no folder watch (checked: no watch in
   `api.project`, the desktop folder handle or the preload's fs bridge), so
   the transport polls every 1.5 s. Complete segments are not read again, so
   a poll reads each member's newest segment, presence line and signal file:
   a few small local files. Each change is written as soon as the engine's
   100 ms batch closes. A folder-watch seam would save the polling but not
   the sync tool's delay, which is the slow part.

Latency through the folder is the sync tool's: a few seconds on a LAN share
or Syncthing, often 10 to 60 s on Google Drive, OneDrive or Dropbox, minutes
when a client is backed up. With direct connections it is only the path for
teammates who can't connect directly and for catching up; the panel names the
path for each teammate ("direct, 12 ms", "relay", "via folder, slower").

### 6.3 Self-hosted relay

A small relay the studio runs on its own account. It orders and stores sealed
entries per room and passes presence along. It never decrypts and never
merges. Two implementations share one room module (`relay/shared/room.mjs`):

- `relay/node/server.mjs`: Node 22, no dependencies (its WebSocket framing is
  built in), for any box or Docker (`relay/node/Dockerfile`). Rooms are kept in
  memory and appended to `DATA_DIR/<roomId>.jsonl`.
- `relay/cloudflare/`: a Worker and a SQLite-backed Durable Object, one object
  per room, using the WebSocket hibernation API so an idle room costs nothing
  on the free plan.

Room id, relay token and seal key all derive from the room code (section 9).
The relay sees only the room id, a hash of the token, entry sizes and timing.

Protocol 1 (JSON text frames over `wss://<host>/v1/rooms/<roomId>/socket`):

| Client → relay | Relay → client |
|---|---|
| `{"type":"hello","token","after","member"}` (first frame, within 10 s) | `{"type":"welcome","head","now"}` then backlog pages |
| `{"type":"push","ref","entries":[...]}` | `{"type":"ack","ref","seqs":[...]}` |
| `{"type":"presence","data"}` | `{"type":"entries","entries":[{"seq","data"}],"head"}` |
| `{"type":"ping"}` | `{"type":"presence","member","data"}`, `{"type":"pong","now"}` |
| `{"type":"signal","data"}` | `{"type":"signal","member","data"}` to the others; never stored |
| | `{"type":"reset","head"}` when the client's place is past the relay's end |
| | `{"type":"error","code","message"}`, closing on `auth` |

The relay sends every pushed entry to every signed-in socket of the room,
the pusher's included (that moves its place in the stream), and presence to
the others only.

HTTPS mode, for cores without the socket seam and before a restart has
applied it (through `api.network.fetch`, bearer token):

- `GET /v1/rooms/<roomId>/entries?after=<seq>&wait=<s>`: long poll (wait ≤ 25 s)
  → `{ head, now, entries, more, presence }`
- `POST /v1/rooms/<roomId>/entries` `{ entries }` → `{ seqs, head }`
- `POST /v1/rooms/<roomId>/presence` `{ member, data }` → `{ ok }`
- `GET /v1/health` → `{ ok, protocol }`

Access: the first authenticated request creates the room and binds the
SHA-256 of its token (trust on first use); every later request must present
the same token. `ALLOWED_ROOMS` (comma-separated ids) locks a relay to the
studio's rooms. Limits per room: 256 KiB per entry, 64 MiB and 200 000 entries
in all (past them a push is refused with `room-full`), 500 entries per page.
Errors are `auth`, `bad-request`, `too-large`, `room-full`, `not-allowed`.

The relay assigns `seq` in arrival order; a client's cursor is the last `seq`
it has. A push whose ack is lost is pushed again; the duplicate is skipped by
`(by, seq)` after opening.

### 6.4 Direct connections (the realtime layer)

`src/realtime/`. A `MeshTransport` wraps the durable transport (folder or
relay) with a `PeerMesh`: one WebRTC data channel (`studio-collab`, ordered,
reliable) to each teammate.

- **Same envelopes.** Entries and presence go down the channel exactly as
  sealed for the durable transport, and the engine checks each against the
  sending member, as it checks the folder's member folders. The durable copy
  arriving later is a duplicate and is skipped. A peer learns nothing it
  wouldn't from the folder.
- **Who offers.** Of two members, the one whose id sorts first makes the
  offer; the other only answers. Two never offer to each other at once.
- **Whole descriptions.** Each side waits for address gathering to finish (up
  to 4 s) and sends its full session description, so a connection takes one
  offer and one answer. Trackers carry one message each way, so trickling
  addresses isn't an option there. On loopback a connection opens in about
  1 s; over the internet expect 1 to 5 s (STUN round trips).
- **Signals** (`signal.ts`): `{ kind: "signal", by, to, type: hello | offer |
  answer, session, peerSession, sdp, at }`, sealed with the room key, ignored
  if older or newer than 5 minutes. `session` is new each run, so a restarted
  teammate is noticed and reconnected. Hellos go out every 15 s.
- **Signal paths, all at once** (`SignalMux`, a blob heard on several is
  handled once):
  1. the durable transport: the relay's socket (`signal` message, passed on,
     never stored; its HTTPS mode carries none), else the shared folder's
     `signal.log` (slow: as fast as the sync tool);
  2. public Nostr relays (`nostr.ts`; `wss://relay.damus.io`, `wss://nos.lol`,
     `wss://relay.primal.net`): ephemeral events (kind 25331, not stored by
     relays), signed with a throwaway key made each run (NIP-01 relays refuse
     unsigned events; `@noble/curves` Schnorr), tagged with the day's topic;
  3. public WebTorrent trackers (`tracker.ts`;
     `wss://tracker.openwebtorrent.com`, `wss://tracker.webtorrent.dev`): the
     swarm is the topic's first 20 bytes, and each signal is sent as ten
     "offers", which the tracker hands one each to other peers.
  The topic is SHA-256 of the room id and the UTC day, so public servers see
  neither the room id nor a tag that links one day to the next. Public
  signalling can be turned off in the panel (then the relay or the folder
  finds teammates). These origins are declared in `permissions.network`
  (`wss:` is allowed there since 3.2.1), so they join the CSP at install.
- **ICE servers:** public STUN (`stun.l.google.com:19302`,
  `stun1.l.google.com:19302`, `stun.cloudflare.com:3478`) plus an optional
  TURN server the studio enters (`turn:`/`turns:` address, user name,
  password). Without TURN, two members behind symmetric NATs can't connect
  directly; their changes go the durable way and the panel says so.
- **Fallback order, per teammate:** direct channel → relay (if the room uses
  one) → shared folder. A connection that doesn't open within 20 s, or fails,
  is dropped and tried again after 30 s, doubling to 5 minutes. The panel
  shows "direct, 12 ms" (round trip, measured by pings every 5 s), "relay",
  or "via folder, slower", with "(connecting directly…)" meanwhile. A
  TURN-relayed connection also shows as "direct": telling the two apart needs
  `getStats`, left for later.
- **Checked in core:** the renderer CSP has no `webrtc` directive and
  `connect-src` doesn't govern RTCPeerConnection or STUN, so nothing blocks
  them; core sets no WebRTC IP-handling policy (no
  `setWebRTCIPHandlingPolicy`, no `force-webrtc-ip-handling-policy`
  switch), and the permission handler grants no camera or microphone, so
  Chromium's default applies: local addresses in candidates are hidden
  behind random `.local` mDNS names, which resolve between machines on the
  same LAN. (To confirm in the app: see the README checklist.)

**Privacy.** What each party learns:

| Who | Learns |
|---|---|
| Teammates (room code holders) | Each other's public IP and port (server-reflexive candidates), and LAN addresses if mDNS obfuscation is off. |
| Public Nostr relays, trackers | The connecting computer's public IP, that it uses a given day's topic, timing and blob sizes. Not the room id, names, photos, edits or SDP (all sealed). Two computers on the same topic on the same day can be linked as one group by the operator. |
| STUN servers (Google, Cloudflare) | The computer's public IP and that it uses WebRTC. |
| The studio's relay | As before, plus signal timing. |

Turning off "Find teammates over the internet" removes the Nostr relays and
trackers from the picture; STUN stays (it is needed for any connection
beyond the LAN; a studio on one LAN can leave it unreachable at no cost).

### 6.5 Cloud-API transports (not built)

| | Google Drive | OneDrive / SharePoint | Dropbox | Immich |
|---|---|---|---|---|
| Auth | OAuth 2 desktop client (loopback redirect), PKCE | Microsoft identity platform, public client, PKCE | OAuth 2 PKCE, no secret | API key (user-made) |
| Scope | `drive.file` (only files the app made or was given) | `Files.ReadWrite` (or `Files.ReadWrite.AppFolder` for an app folder, but app folders don't share) | `files.content.write`, `files.content.read` | `album.read`, `album.update`, `asset.read`, `asset.update` |
| Change feed | `changes.list` + `startPageToken`; push needs a public HTTPS webhook (`changes.watch`), so poll | `/delta` per drive; webhooks need a public endpoint, so poll | `list_folder/continue` + `list_folder/longpoll` (no webhook needed) | none for metadata; poll `/api/albums/:id` and assets by `updatedAfter` |
| Origins | `https://www.googleapis.com`, `https://oauth2.googleapis.com` | `https://graph.microsoft.com`, `https://login.microsoftonline.com` | `https://api.dropboxapi.com`, `https://content.dropboxapi.com`, `https://notify.dropboxapi.com` | the server, user-entered (`api.network`) |
| Shape | same layout as 6.2 as Drive files | same as 6.2 | same as 6.2, longpoll gives near-realtime | see below |

Each is one `CollabTransport` that writes the section 6.2 layout through a
REST API instead of a desktop client. They would need: a registered OAuth app
per provider (client id in the manifest, no secret for public clients), the
core loopback sign-in and token storage another session is building
(`oauth-loopback.cjs`, `extension-secrets.cjs`), declared origins in
`permissions.network`, and per-provider rate-limit handling.

Verdict: not worth building in v1. The folder transport already reaches every
one of these services through their desktop clients, with no OAuth app to
register, verify (Google requires app verification for sensitive scopes) and
keep alive, and no tokens to guard. A cloud transport earns its keep only for a
member who can't install the provider's desktop client (a locked-down machine);
Dropbox would be first, because longpoll gives near-realtime without a
webhook.

Immich: its API can hold some shared state (album membership,
`isFavorite`, `isArchived`, `rating` in asset EXIF since 1.11x, description),
but not flags, colour labels, keywords as editable tags with per-tag merge
semantics, stages, presence or develop edits, and it has no change feed for
metadata or ordering. It would carry only a lossy subset and need polling.
Worth doing, if at all, as an *export bridge* (push picks and ratings into an
Immich album for clients), not as a sync transport. The ops could be stored
in Immich as a hidden asset's description, but that abuses the API and is
fragile.

## 7. Presence, roles and soft locks

Presence entry (sealed like ops, sent every 15 s on the relay and 30 s on a
folder):

```json
{ "v": 1, "kind": "presence", "by": "8f3c…", "name": "Ana", "role": "culler",
  "module": "develop", "photo": "p:Day 1/IMG_0042.CR3", "editing": true,
  "wall": 1763060000123, "app": "1.0.0" }
```

- Roles: shooter, culler, editor, exporter. Each member picks theirs; it is
  shown, not enforced.
- Fresh while `wall` is within 90 s (relay) or 4 min (folder) of now.
- Soft lock: a fresh presence with `editing: true` on a photo shows "Being
  edited by Ana" in the panel for that photo, and in the presence bar. Nothing
  is blocked; two people may still edit, and the merge keeps the newest change
  per parameter.
- A remote develop edit for the photo open in Develop is not applied while it
  is open (it would reload the canvas and drop the active tool). The panel
  shows "Ana changed this photo's edit" with an Apply button; leaving the
  photo applies it.

## 8. Core seam: user-approved live connections (`api.sockets`)

Problem. The renderer's CSP `connect-src` allows only origins a manifest
declares in `permissions.network`, read at launch. A studio's own relay
address can't be known when the extension is published. `api.network` (3.2.4)
lets the person approve an address, but its requests are made by the main
process: a request and its answer, not a WebSocket.

Design (additive, small):

- Manifest flag `permissions.userSockets: true`. Without it nothing below
  answers for the extension.
- `api.sockets.requestAccess(url)`: core (main process) shows a **native
  dialog that names the extension and the address**; the extension can't draw
  it, word it or click it. Only a `wss://` origin is accepted, and only one
  that matches `VALID_CONNECT_ORIGIN` from `electron/extension-origins.cjs`
  (no wildcard, no path, no user info, no `ws:`, no IP-literal brackets).
- The grant is kept in main, per extension, in `<userData>/socket-grants.json`
  (version 1, same damaged-file handling as `network-grants.json`). It is
  forgotten when the extension is uninstalled; an update keeps it.
- **At launch**, main adds every granted origin of every installed (or
  dev-folder) extension that still declares `userSockets` to `connect-src`,
  through the same validation as declared origins. The CSP is built once per
  launch, so **a new grant takes effect after a restart**. That restart is the
  same consent point declared origins already use, and it means a page can
  never widen its own live policy.
- `api.sockets.status(url)` answers `"allowed"` (granted and in this launch's
  policy), `"after-restart"` (granted, not yet live) or `"not-allowed"`.
  `list()` and `revokeAccess(url)` complete it. A revoke takes the origin out
  of the next launch's policy.
- The store's extension page lists the approved addresses under Permissions,
  with a Disconnect button (`src/extensions/AllowedSockets.tsx`).

Built in core (3.2.5): `electron/socket-access.cjs` (validation, grants,
`readSocketGrantOrigins` for the launch policy), `electron/ipc/sockets.cjs`
(privileged `sockets:request|status|list|revoke`, the consent dialog),
`loadLaunchHosts` in `electron/main.cjs`, the preload's privileged `sockets`
group, `src/extensions/sockets.ts` and `api/sockets.ts`, and
`permissions.userSockets` in the manifest type.

The relay transport uses the socket only when `api.sockets.status` says
`"allowed"`. Otherwise (an older core, or before the restart) it talks to the
same relay over HTTPS through `api.network`, which the person allows with its
own dialogue, so the room works at once and turns live after a restart.

Security notes:

- `connect-src` is page-wide. Once a relay origin is in it, any code in the
  renderer may open a connection there, as with declared origins today.
  Extensions already share the renderer realm with full access, so the
  permission is consent and disclosure, not a sandbox; the store says so.
- It widens data egress only: `script-src` is untouched, so no code loads from
  the approved origin. Under CSP3 a `wss://host` source also matches
  `https://host` on the same port; the dialogue says so.
- One consent dialogue per extension at a time; a grant or revoke is kept
  only once it is on disk, so memory and the next launch agree.
- Known limits (accepted, as for `api.network`): the dialogue shows the
  manifest's `name`, not its id; a dev-folder manifest reusing an installed
  extension's id inherits that id's grants (the person picked that folder).
- Only the core's privileged bridge (claimed at boot) reaches the IPC, and it
  names the calling extension itself, so an extension can't ask in another's
  name. All channels go through `handlePrivileged`.
- The grant file is read with the same validation at launch, so a hand-edited
  or damaged file can't inject `*`, `'unsafe-eval'` or a scheme.
- Requests and answers to the relay through `api.network` (HTTPS mode) stay
  per-extension enforced in main.

## 9. Security model

Room code: `slc1-` + base64url of 32 random bytes, made on "Create room" and
shared out of band (a message, a password manager). Everything derives from it
with HKDF-SHA-256 (salt `safelight-studio-collab/1`):

| info | output | used for |
|---|---|---|
| `room-id` | 16 bytes, hex | folder name, relay room |
| `seal-key` | AES-256-GCM key | sealing ops and presence |
| `relay-token` | 32 bytes, base64url | relay access (relay stores its SHA-256) |

- Someone with access to the shared folder or the relay host but not the code
  can't read anything (contents are encrypted; names, sizes and timing show),
  can't add or change ops (AES-GCM authenticates every entry; forgeries are
  rejected and counted), and can't replay an entry into another room
  (additional data binds the room id). They can delete or corrupt files: that
  shows as members going quiet and rejected counts, and losing the folder
  loses only what wasn't merged elsewhere, since every member holds the full
  state.
- A replayed old entry within the room changes nothing: it is a duplicate, or
  its stamp loses to the newer one.
- Everyone with the code is a full member. Members can write ops under another
  member's id; the room trusts its members. Per-member signatures (Ed25519)
  would stop that; they are left for later because they need key distribution
  and revocation to mean anything.
- Where Safelight has a keychain (`api.secrets`, 3.2.5: DPAPI, the macOS
  Keychain, the Secret Service), the code is kept there and the settings
  hold only `keychain: true`. On older cores, or with no keychain, it is kept
  in the extension's settings on that computer, in the clear, like every
  extension setting.
- Removing a member means a new room: create one, share the new code with the
  rest; the new room is seeded from their catalogues.

## 10. UI

Panel "Studio Collab", docked right in Library, available in Develop.

Not in a room:
- Your name, your role.
- Create room: pick transport (Shared folder / Relay); folder: Choose folder;
  relay: address, Allow address. Then the room code to share.
- Join room: paste the code, same transport choice.

In a room:
- Status line: transport, phase (connecting, live, catching up, offline,
  problem), "last change from Ben 40 s ago", unsent changes, rejected entries,
  held entries (clock).
- People: name, role, what they're on ("culling IMG_0042.CR3", "editing
  IMG_0101.NEF"), last seen, and the path their changes take: "direct,
  12 ms", "relay", "via folder, slower".
- Connections: "Find teammates over the internet" (public signalling, on by
  default, with what it exposes in one paragraph) and an optional TURN server.
- This photo (active or first selected): stage (segmented control: Shot,
  Culled, Edited, Exported), "Being edited by Ana", deferred remote edit with
  Apply.
- Team collections: list with counts, New, Add selected, Remove selected,
  show in grid, rename, delete (confirmDialog).
- Copy room code, Leave room (confirmDialog).

Library sub-bar slot: a one-line presence strip (who is on, what they're on).

Grid: core has no per-cell badge hook, so a "Being edited by" badge on
thumbnails would need a new core contribution (`registerThumbnailBadge`, a
small, pure function of the photo returning an icon and a tooltip). Not built:
the presence strip, the panel and the grid filters ("Stage", "Not being
edited by others", team collection) cover it without a core change.

All controls are `api.ui` kit components; colours come from `api.ui.tokens`.
Confirmations use `api.ui.confirmDialog`, never `window.confirm`.

Windows: the engine runs in the main window only (a pop-out window has
`?detached=` in its URL). Edits committed in a pop-out Develop window reach it
through the `edit-update` broadcast and the catalogue store.

## 11. Local state

- Settings (`api.settings`, per computer): `profile` (name, role), `room`
  (code or `keychain: true`, transport, kept-folder token or relay address,
  the project it follows), `members` (this computer's member id per room),
  `autoStage`, `realtime` (`publicSignalling`, `turn`: url, user name,
  password, kept in the clear like other settings).
- The room follows the project it was made or joined in (its folder path):
  with another project open, sync pauses and the panel offers to follow the
  open one instead. That keeps an unrelated shoot's ratings out of the room.
- IndexedDB `studio-collab` (one record per room): merged state, seen op ids,
  transport cursor, outbox, own seq, clock, seeded flag. Saved two seconds after
  a change and on leave. Losing it costs a full catch-up, nothing else.

## 12. Failure modes

| Failure | Behaviour |
|---|---|
| Offline (relay) | Ops queue in the outbox (kept in IndexedDB); reconnect with backoff 1 s to 30 s; HTTPS mode retries each poll. |
| Offline (folder) | Writes land in the local folder; the sync tool uploads later. |
| Sync tool paused or slow | Members' "last heard" ages grow; the panel shows it. |
| Conflicted copies | Read and merged; duplicates skipped. |
| Truncated or partial file | Incomplete tail ignored until complete. |
| Corrupt or foreign entry | Rejected, counted, shown. |
| Wrong room code | Every entry is rejected; the panel says the code doesn't match the room's entries. |
| Clock far ahead | Ops held; panel names the member and the skew. |
| Relay restarted (Node) | Rooms reload from `DATA_DIR`; clients reconnect and resume from their cursor. |
| Relay data lost | Clients' cursors are past the relay head: the client resets its cursor to 0 and republishes its own full state (the merge makes that safe). |
| Relay full | Push refused with `room-full`; the panel says so. |
| Photo renamed | Relinked by fingerprint if unchanged otherwise; else starts afresh under the new key. |
| Photo missing locally | Its state is kept and applied when it appears. |
| Two windows | Only the main window syncs. |
| Big edits (masks) | Ops split at 400 changes; a single value over 200 KiB is not synced and is reported. |
| No direct route (symmetric NAT, blocked UDP) | Connection given up after 20 s, retried with backoff; changes go by relay or folder; the panel says which. A TURN server fixes it. |
| Public signalling down or blocked | Other buses carry signals; with all public ones down, the relay or the folder finds teammates (folder: as slow as its sync). |
| Teammate restarts | New session in its hello; the old connection is dropped and a new one made. |
| No WebRTC in the window | The durable transport alone, as in 1.0.0 before this layer. |

## 13. Later

- Show TURN-relayed connections apart from direct ones (`getStats`).
- Slow the hellos down once every known teammate is connected, so the shared
  folder's `signal.log` isn't rewritten every 15 s.

- Collections interop: Collections publishes `collections.v1` through
  `api.variables` (`{ id, name, photoIds }[]`) and accepts writes; Studio
  Collab maps photo ids to keys and syncs it as `col/` fields.
- Compaction: a member writes a sealed snapshot of the merged state; relays
  drop entries before the oldest snapshot every member has passed, folders
  drop a member's own segments behind its snapshot.
- Per-member signing keys, member removal without a new room.
- `registerThumbnailBadge` core seam for grid badges.
- Cloud-API transports (section 6.5), Dropbox first.
