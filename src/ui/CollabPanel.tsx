// The Studio Collab panel: who you are, then either room setup or the room:
// its status, the people in it, the photo you are on, team collections and
// the grid filter.

import { React, session, ui } from "../rt";
import { ROLES } from "../sync/payload";
import { STAGES, isStage, type Stage } from "../sync/catalog-sync";
import type { SessionView } from "../app/session";
import { Setup } from "./Setup";
import { ROLE_LABELS, STAGE_LABELS, activity, ago, ahead, linkLabel } from "./format";
import { turnAddress } from "../settings";

const small = (color: string): { fontSize: number; color: string; lineHeight: number } => ({
  fontSize: 10,
  color,
  lineHeight: 1.5,
});

export function useSessionView(): SessionView {
  return React.useSyncExternalStore(session.subscribe, session.getView);
}

/** Re-render every few seconds, for "40 s ago". */
function useNow(every = 5000): number {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

function Profile({ view }: { view: SessionView }) {
  const { Field, Row, Select, TextInput } = ui;
  const [name, setName] = React.useState(view.profile.name);
  React.useEffect(() => setName(view.profile.name), [view.profile.name]);
  return (
    <Row gap={8} align="flex-end">
      <div style={{ flex: 1, minWidth: 0 }}>
        <Field label="Your name">
          <TextInput
            value={name}
            onChange={setName}
            onBlur={() => session.setProfile({ ...view.profile, name: name.trim() })}
            placeholder="Shown to the team"
            aria-label="Your name"
          />
        </Field>
      </div>
      <div style={{ width: 110 }}>
        <Field label="Role">
          <Select
            value={view.profile.role}
            onChange={(v) => session.setProfile({ ...view.profile, role: ROLES.find((r) => r === v) ?? "" })}
            options={[{ value: "", label: "None" }, ...ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))]}
            ariaLabel="Your role"
          />
        </Field>
      </div>
    </Row>
  );
}

function Status({ view, now }: { view: SessionView; now: number }) {
  const { Badge, Button, Card, Row, Stack, tokens } = ui;
  const room = view.room;
  const engine = view.engine;
  if (!room) return null;
  const how =
    room.transport === "folder"
      ? `Shared folder: ${room.folderLabel || "chosen folder"}. It keeps the record; through it, changes take seconds to minutes.`
      : view.relayMode === "socket"
        ? "Relay, live connection."
        : "Relay, checked every few seconds.";
  const phase =
    view.phase === "running"
      ? engine?.phase === "live"
        ? "Connected"
        : engine?.phase === "offline"
          ? "Offline"
          : engine?.phase === "problem"
            ? "Problem"
            : "Connecting"
      : view.phase === "starting"
        ? "Starting"
        : view.phase === "problem"
          ? "Problem"
          : "Paused";
  const detail = view.phase === "problem" ? view.problem : engine?.phase === "live" ? "" : (engine?.detail ?? "");
  return (
    <Card>
      <Stack gap={6}>
        <Row justify="space-between">
          <span style={{ fontSize: 11, color: tokens.textPrimary }}>Room</span>
          <Badge>{phase}</Badge>
        </Row>
        <span style={small(tokens.textSecondary)}>{how}</span>
        {detail && <span style={small(tokens.labelRed)}>{detail}</span>}
        {engine && engine.members.length > 0 && (
          <span style={small(tokens.textSecondary)}>
            Connected directly to {engine.members.filter((m) => m.link === "direct").length} of {engine.members.length}{" "}
            {engine.members.length === 1 ? "teammate" : "teammates"}
          </span>
        )}
        {view.phase === "other-project" && (
          <Stack gap={6}>
            <span style={small(tokens.textSecondary)}>
              This room follows {room.project || "another project"}. Open it to sync, or let the room follow the
              project open now.
            </span>
            <Button size="sm" onClick={() => void session.useOpenProject()}>
              Use this project
            </Button>
          </Stack>
        )}
        {view.phase === "no-project" && <span style={small(tokens.textSecondary)}>Open the shoot's folder to sync.</span>}
        {engine && engine.unsent > 0 && (
          <span style={small(tokens.textSecondary)}>
            {engine.unsent} {engine.unsent === 1 ? "change" : "changes"} waiting to be sent
          </span>
        )}
        {engine && engine.rejected > 0 && (
          <span style={small(tokens.labelYellow)}>
            {engine.rejected} {engine.rejected === 1 ? "entry" : "entries"} turned away: not sealed with this room's code
          </span>
        )}
        {engine?.held.map((h) => (
          <span key={h.by} style={small(tokens.labelYellow)}>
            {h.name}'s clock runs {ahead(h.aheadMs)} ahead; their changes wait until it is set right.
          </span>
        ))}
        {room.transport === "relay" && view.phase === "running" && view.relayMode === "poll" && view.socketAccess !== "unavailable" && (
          <LiveUpgrade relayUrl={room.relayUrl} access={view.socketAccess} />
        )}
        <span style={small(tokens.textMuted)}>
          Last change from the team: {ago(lastChange(view), now)}
        </span>
        {view.roomId && (
          <span style={{ ...small(tokens.textMuted), fontFamily: tokens.fontCode, userSelect: "text" }}>
            Room id {view.roomId}
          </span>
        )}
      </Stack>
    </Card>
  );
}

function lastChange(view: SessionView): number | null {
  const times = (view.engine?.members ?? []).map((m) => m.lastChangeAt).filter((t): t is number => t !== null);
  return times.length ? Math.max(...times) : null;
}

function LiveUpgrade({ relayUrl, access }: { relayUrl: string; access: SessionView["socketAccess"] }) {
  const { Button, tokens } = ui;
  if (access === "after-restart")
    return <span style={small(tokens.textSecondary)}>Restart Safelight to switch to the live connection.</span>;
  return (
    <Button size="sm" onClick={() => void session.allowLiveConnection(relayUrl)}>
      Use a live connection
    </Button>
  );
}

function People({ view, now }: { view: SessionView; now: number }) {
  const { Section, Stack, Row, tokens } = ui;
  const members = view.engine?.members ?? [];
  return (
    <Section title="People">
      {members.length === 0 ? (
        <span style={small(tokens.textMuted)}>Nobody else has been heard from yet.</span>
      ) : (
        <Stack gap={4}>
          {members.map((m) => (
            <Row key={m.id} gap={6} align="baseline">
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  flex: "none",
                  background: m.fresh ? tokens.labelGreen : tokens.textMuted,
                }}
              />
              <span style={{ fontSize: 11, color: tokens.textPrimary }}>{m.name}</span>
              {m.role && <span style={small(tokens.textMuted)}>{ROLE_LABELS[m.role]}</span>}
              <span style={{ ...small(tokens.textSecondary), flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.fresh
                  ? m.photo
                    ? `${activity(m.module, m.editing, m.role)} ${session.photoNameFor(m.photo)}`
                    : activity(m.module, false, m.role)
                  : `seen ${ago(m.seenAt, now)}`}
              </span>
              <span style={{ ...small(m.link === "direct" ? tokens.labelGreen : tokens.textMuted), flex: "none" }}>
                {linkLabel(m)}
              </span>
            </Row>
          ))}
        </Stack>
      )}
    </Section>
  );
}

function ThisPhoto({ view }: { view: SessionView }) {
  const { Button, Section, SegmentedControl, Stack, tokens } = ui;
  const ids = view.here.selectedIds.length ? view.here.selectedIds : view.here.photoId ? [view.here.photoId] : [];
  const photoId = view.here.photoId;
  const info = photoId ? session.photoInfo(photoId) : null;
  if (!photoId || !info) return null;
  return (
    <Section title={ids.length > 1 ? `${ids.length} photos` : "This photo"}>
      <Stack gap={6}>
        <SegmentedControl
          size="sm"
          value={info.stage}
          onChange={(v) => {
            const stage: Stage | undefined = isStage(v) ? v : undefined;
            if (stage) session.setStage(ids, stage);
          }}
          options={STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }))}
        />
        {info.editedBy.length > 0 && (
          <span style={small(tokens.labelYellow)}>Being edited by {info.editedBy.join(", ")}</span>
        )}
        {info.viewedBy.length > 0 && (
          <span style={small(tokens.textSecondary)}>Also open for {info.viewedBy.join(", ")}</span>
        )}
        {info.waitingEdit && (
          <Stack gap={4}>
            <span style={small(tokens.textSecondary)}>
              Someone changed this photo's edit. It is applied when you leave the photo, or now:
            </span>
            <Button size="sm" onClick={() => void session.applyWaitingEdit(photoId)}>
              Apply their edit
            </Button>
          </Stack>
        )}
        {info.tooBig && (
          <span style={small(tokens.textMuted)}>Part of this edit is too big to share (over 200 KB) and stays here.</span>
        )}
      </Stack>
    </Section>
  );
}

function Collections({ view }: { view: SessionView }) {
  const { Button, Row, Section, Stack, TextInput, tokens } = ui;
  const [name, setName] = React.useState("");
  const [renaming, setRenaming] = React.useState<{ id: string; name: string } | null>(null);
  const ids = view.here.selectedIds.length ? view.here.selectedIds : view.here.photoId ? [view.here.photoId] : [];
  const info = view.here.photoId ? session.photoInfo(view.here.photoId) : null;
  const create = () => {
    if (session.createCollection(name)) setName("");
  };
  return (
    <Section title="Team collections">
      <Stack gap={4}>
        {view.collections.map((c) => {
          const shown = view.filter.collection === c.id;
          const holds = info?.collections.includes(c.id) ?? false;
          return renaming?.id === c.id ? (
            <TextInput
              key={c.id}
              value={renaming.name}
              autoFocus
              onChange={(v) => setRenaming({ id: c.id, name: v })}
              onBlur={() => {
                session.renameCollection(c.id, renaming.name);
                setRenaming(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setRenaming(null);
              }}
              aria-label="Collection name"
            />
          ) : (
            <Row key={c.id} gap={4}>
              <span
                onDoubleClick={() => setRenaming({ id: c.id, name: c.name })}
                title="Double-click to rename"
                style={{ fontSize: 11, color: tokens.textPrimary, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {c.name} <span style={{ color: tokens.textMuted }}>{c.count}</span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                active={shown}
                title="Show only this collection in the grid"
                onClick={() => session.setFilter({ ...view.filter, collection: shown ? "" : c.id })}
              >
                Show
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={ids.length === 0}
                title={holds ? "Take the selected photos out" : "Add the selected photos"}
                onClick={() => session.setInCollection(ids, c.id, !holds)}
              >
                {holds ? "Remove" : "Add"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Delete this collection for everyone"
                onClick={() =>
                  void ui
                    .confirmDialog({
                      title: "Delete team collection",
                      message: `Delete “${c.name}” for everyone in the room? The photos stay where they are.`,
                      confirmLabel: "Delete",
                      variant: "danger",
                    })
                    .then((yes) => yes && session.deleteCollection(c.id))
                }
              >
                ✕
              </Button>
            </Row>
          );
        })}
        <Row gap={4}>
          <div style={{ flex: 1 }}>
            <TextInput
              value={name}
              onChange={setName}
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
              placeholder="New collection"
              aria-label="New collection name"
            />
          </div>
          <Button size="sm" disabled={!name.trim()} onClick={create}>
            New
          </Button>
        </Row>
      </Stack>
    </Section>
  );
}

function Filter({ view }: { view: SessionView }) {
  const { Section, Select, Stack, Toggle } = ui;
  return (
    <Section title="Grid">
      <Stack gap={6}>
        <Select
          value={view.filter.stage}
          onChange={(v) => session.setFilter({ ...view.filter, stage: isStage(v) ? v : "" })}
          options={[{ value: "", label: "Every stage" }, ...STAGES.map((s) => ({ value: s, label: `Only ${STAGE_LABELS[s].toLowerCase()}` }))]}
          ariaLabel="Show photos at stage"
        />
        <Toggle
          checked={view.filter.hideOthersEditing}
          onChange={(on) => session.setFilter({ ...view.filter, hideOthersEditing: on })}
          label="Hide photos others are editing"
        />
      </Stack>
    </Section>
  );
}

function Connections({ view }: { view: SessionView }) {
  const { Button, Field, Section, Stack, TextInput, Toggle, tokens } = ui;
  const saved = view.realtime.turn;
  const [url, setUrl] = React.useState(saved?.url ?? "");
  const [username, setUsername] = React.useState(saved?.username ?? "");
  const [credential, setCredential] = React.useState(saved?.credential ?? "");
  if (!view.directAvailable)
    return (
      <Section title="Connections">
        <span style={small(tokens.textMuted)}>Direct connections aren't available in this window.</span>
      </Section>
    );
  const turnUrl = turnAddress(url);
  const changed = url !== (saved?.url ?? "") || username !== (saved?.username ?? "") || credential !== (saved?.credential ?? "");
  return (
    <Section title="Connections">
      <Stack gap={8}>
        <Toggle
          checked={view.realtime.publicSignalling}
          onChange={(on) => session.setRealtime({ ...view.realtime, publicSignalling: on })}
          label="Find teammates over the internet"
        />
        <span style={small(tokens.textMuted)}>
          Teammates connect directly, so changes arrive at once. To find each other they leave sealed notes on public
          Nostr relays and WebTorrent trackers, which see your IP address and a room tag that changes daily, never
          your photos or edits. Off, they find each other through {view.room?.transport === "relay" ? "your relay" : "the shared folder, which is slower"}.
        </span>
        <Field label="TURN server (optional)" hint="For networks that block direct connections, if your studio runs one: turn: or turns: address.">
          <Stack gap={4}>
            <TextInput value={url} onChange={setUrl} placeholder="turns:turn.your-studio.com:5349" aria-label="TURN server" />
            <TextInput value={username} onChange={setUsername} placeholder="User name" aria-label="TURN user name" />
            <TextInput value={credential} onChange={setCredential} type="password" placeholder="Password" aria-label="TURN password" />
            <Button
              size="sm"
              disabled={!changed || (url !== "" && !turnUrl)}
              onClick={() =>
                session.setRealtime({ ...view.realtime, turn: turnUrl ? { url: turnUrl, username, credential } : null })
              }
            >
              Save
            </Button>
          </Stack>
        </Field>
      </Stack>
    </Section>
  );
}

function RoomFooter({ autoStage }: { autoStage: boolean }) {
  const { Button, Row, Stack, Toggle } = ui;
  const [copied, setCopied] = React.useState(false);
  return (
    <Stack gap={8}>
      <Toggle checked={autoStage} onChange={(on) => session.setAutoStage(on)} label="Advance stages automatically" />
      <Row gap={6}>
        <Button
          size="sm"
          onClick={() =>
            void session.copyCode().then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? "Copied" : "Copy room code"}
        </Button>
        <Button
          size="sm"
          variant="danger"
          onClick={() =>
            void ui
              .confirmDialog({
                title: "Leave room",
                message:
                  "Stop syncing with this room on this computer? Your catalogue keeps everything it has. You can join again with the room code.",
                confirmLabel: "Leave",
              })
              .then((yes) => (yes ? session.leaveRoom() : undefined))
          }
        >
          Leave room
        </Button>
      </Row>
    </Stack>
  );
}

export function CollabPanel() {
  const { Stack, tokens } = ui;
  const view = useSessionView();
  const now = useNow();
  if (!view.mainWindow)
    return (
      <div style={{ padding: 10, ...small(tokens.textSecondary) }}>
        Studio Collab runs in the main window. What you change here reaches the room through it.
      </div>
    );
  return (
    <div style={{ padding: 10 }}>
      <Stack gap={14}>
        <Profile view={view} />
        {view.room ? (
          <>
            <Status view={view} now={now} />
            {view.phase === "running" && (
              <>
                <People view={view} now={now} />
                <ThisPhoto view={view} />
                <Collections view={view} />
                <Filter view={view} />
                <Connections view={view} />
              </>
            )}
            <RoomFooter autoStage={session.autoStage()} />
          </>
        ) : (
          <Setup />
        )}
      </Stack>
    </div>
  );
}
