# Studio Collab for Safelight

Work on one shoot as a team. When shooting, culling, editing and export are
split between people, Studio Collab keeps everyone's Safelight in step:

- **Ratings, flags, colour labels and keywords**, as soon as they change.
- **Develop edits**, merged per setting: Ana's exposure and Ben's white
  balance on the same photo both survive. A teammate's edit lands as one new
  step in your history, so you can undo it.
- **Team collections** everyone shares, with a grid filter to show one.
- **Stages**: each photo moves from Shot to Culled, Edited and Exported as the
  team works (or set it by hand), with a grid filter by stage.
- **Who is where**: a line under the Library toolbar and the panel show who is
  culling or editing which photo, and the panel warns "Being edited by Ana"
  before you start on the same one. Nothing is locked.

Nobody has to host anything. **Teammates connect to each other directly**, so a
change shows on everyone else's screen within about a second. Behind that,
the room keeps its record in something the studio already has, which also
catches up whoever was away and carries changes to anyone who can't connect
directly:

| | Shared folder | Relay (optional) |
|---|---|---|
| What | A folder Google Drive, OneDrive, Dropbox, Syncthing or a NAS keeps the same on every computer | A small server your studio runs: on Cloudflare's free plan, or any computer with Node or Docker |
| For teammates who can't connect directly | Seconds to minutes, as fast as the sync tool | Within a second or two |
| Setup | Pick the folder | Deploy once, then enter its address |

The panel shows, for each teammate, how their changes reach you: **direct**
(with the round trip, such as "direct, 12 ms"), **relay**, or **via folder,
slower**.

Everything that leaves your computer is encrypted with the room code (AES-256-GCM).
The shared folder's provider and the relay only ever see sealed data:
not your photos' names, your ratings, your keywords or your edits. Your photos
themselves stay where your team keeps them; Studio Collab never copies them.

Needs Safelight 3.2.4. Live relay connections need Safelight 3.2.5.

## Before you start

- Everyone opens **the same shoot folder** as the project (on the shared drive
  or NAS). Photos are matched by their path in that folder. Someone who opened
  it a level up or down is matched by file name, size and capture time instead.
- Each person sets **their name** and **role** at the top of the Studio
  Collab panel (open it from the View menu if it isn't showing).

## Direct connections

Each computer opens a WebRTC data channel to each teammate's. On the same
network they connect at once; over the internet, through home and office
routers, most do too. To find each other, the computers leave sealed notes
for each other on free public servers (Nostr relays and WebTorrent
trackers), on your relay if you have one, and in the shared folder. The notes
are encrypted with the room code; the servers can't read them.

Two computers behind strict routers (symmetric NAT) sometimes can't connect
directly. Their changes still arrive, by relay or through the folder, and the
panel says so. A studio that runs a TURN server can enter it under
**Connections ▸ TURN server** to connect those too.

**What connecting directly reveals:**

- Teammates (anyone with the room code) see each other's public IP address.
- The public Nostr relays and trackers see your public IP address, that you
  use a room tag, which changes every day, and when. They never see the room's
  name, your photos, ratings or edits, or anything in the notes.
- The STUN servers that tell a computer its public address (Google's and
  Cloudflare's) see your IP address and that you use WebRTC.

Turn **Connections ▸ Find teammates over the internet** off to keep the
public relays and trackers out of it. Teammates then find each other through
your relay, or through the shared folder (which takes as long as the sync
tool, after which the connection is direct).

## Shared folder

1. Make a folder the whole team syncs: a shared drive or shared folder in
   Google Drive, OneDrive or SharePoint, Dropbox, a Syncthing folder, or a
   folder on the NAS everyone mounts. It can be the shoot folder itself.
2. The first person opens the shoot in Safelight, then in the Studio Collab
   panel: **Create a room ▸ Shared folder ▸ Choose folder…**, picks their copy
   of the shared folder, and clicks **Create room**.
3. They click **Copy room code** and send the code to the team privately (a
   direct message or a password manager, not a public channel).
4. Everyone else opens the shoot, then **Join a room**, pastes the code, picks
   *their own* copy of the shared folder, and clicks **Join room**.

Studio Collab writes into `studio-collab/<room>/members/<computer>/` in that
folder. Each computer writes only its own files, so the sync tool never has to
choose between two versions. Conflicted copies, files that arrive late or cut
off, and temp files are all handled.

Tips:

- With Google Drive for desktop or OneDrive, keep the folder **available
  offline** (or "always keep on this device") so changes don't wait on a
  download.
- Teammates who are connected directly get changes at once; the folder's
  speed matters for the others and for catching up.

## Relay

The relay is a mailbox for sealed entries: it numbers them, keeps them and
passes them on. It can't read any of them.

### Relay on Cloudflare (free plan)

Uses a Worker and one Durable Object per room. An idle room sleeps and costs
nothing.

1. Make a free Cloudflare account and install Node 22 or later.
2. From this repository's `relay/cloudflare` folder:

   ```sh
   npx wrangler login
   npx wrangler deploy
   ```

3. Wrangler prints the address, such as
   `https://studio-collab-relay.<you>.workers.dev`. That is the relay address.
   A custom domain can be added in the Cloudflare dashboard.
4. Optional: once your room exists, lock the relay to it. The panel shows the
   room id under the room's status (it isn't secret). Set `ALLOWED_ROOMS` in
   `wrangler.toml` to it and deploy again.

### Relay on your own computer, NAS or server (Node or Docker)

Node 22 or later, no packages:

```sh
PORT=8787 DATA_DIR=./data node relay/node/server.mjs
```

Or Docker, from this repository's root:

```sh
docker build -t studio-collab-relay -f relay/node/Dockerfile .
docker run -d --name studio-collab-relay -p 8787:8787 -v studio-collab-data:/data studio-collab-relay
```

Safelight reaches a relay only at an `https://` address, so put it behind
HTTPS: a reverse proxy with a certificate (Caddy does it in two lines:
`relay.your-studio.com { reverse_proxy localhost:8787 }`), or a tunnel such as
Cloudflare Tunnel or Tailscale Funnel. Rooms are kept in `DATA_DIR` and read
back when the relay restarts. `ALLOWED_ROOMS=<id>,<id>` locks it to your rooms.

### Joining through a relay

1. In the panel: **Create a room** (or **Join a room** with the code) **▸
   Relay**, enter the relay address, click **Allow address** and allow it in
   Safelight's dialogue, then **Create room** / **Join room**.
2. The room works straight away, checking the relay every few seconds.
3. On Safelight 3.2.5 or later, click **Use a live connection** in the panel
   and allow it. After you restart Safelight, the relay is live too, and it
   also helps teammates find each other for direct connections.

The relay's address can be changed or disconnected on the extension's page in
the Extensions window.

### Limits

Per room, the relay keeps up to 64 MiB and 200,000 entries; each entry is at
most 256 KiB. A full room says so in the panel: make a new room for the next
shoot.

## Security

- **The room code is the key.** Anyone with it can read and change the
  room. Share it privately. Safelight keeps it in your computer's keychain
  where it can (Safelight 3.2.5 and later), otherwise in the extension's
  settings.
- Without the code, someone who can reach the shared folder or the relay can't
  read anything or add a change: every entry is encrypted and checked, and
  anything that doesn't check out is turned away and counted in the panel.
  They can delete files, which shows as people going quiet.
- To remove someone from a room, make a new room and share its code with the
  others. Everyone's catalogue already holds the room's state, so nothing is
  lost.
- A computer whose clock runs more than 10 minutes ahead has its changes held
  until its clock is right; the panel names it.

## What isn't synced

Rotation, stacks, creating virtual copies, file moves and renames (the
shared drive carries those), presets, and Safelight's own Collections
extension (Studio Collab's team collections are separate). A develop setting
bigger than 200 KB (a very large mask, say) stays on the computer that made it.

## Development

```sh
npm install
npm run check   # typecheck, build, and every test
```

The tests run the Node relay on a local port, the Cloudflare relay against
stand-ins for its storage and sockets, the shared-folder transport against a
temp folder with the things sync tools do, direct connections over real
WebRTC on loopback (`node-datachannel`, a development dependency only), and
signalling through in-memory stand-ins for a Nostr relay and a tracker. No
test reaches a public server. The design is in
[docs/SPEC.md](docs/SPEC.md).

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE). The bundle includes MIT-licensed
code from `@noble/curves` and `@noble/hashes`; see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
