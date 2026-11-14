// Making or joining a room: the code, and how the room is reached.

import { relayAddress } from "../settings";
import { React, session, ui } from "../rt";
import type { SetupChoice } from "../app/session";

type Mode = "create" | "join";
type Way = "folder" | "relay";

export function Setup() {
  const { Button, Field, SegmentedControl, Stack, TextInput } = ui;
  const [mode, setMode] = React.useState<Mode>("create");
  const [way, setWay] = React.useState<Way>("folder");
  const [code, setCode] = React.useState("");
  const [folder, setFolder] = React.useState<{ token: string; label: string } | null>(null);
  const [relay, setRelay] = React.useState("");
  const [relayAllowed, setRelayAllowed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState("");

  const relayUrl = relayAddress(relay);
  const choice: SetupChoice | null =
    way === "folder"
      ? folder && { transport: "folder", folderToken: folder.token, folderLabel: folder.label }
      : relayUrl && relayAllowed
        ? { transport: "relay", relayUrl }
        : null;

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setProblem("");
    try {
      await task();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    run(async () => {
      if (!choice) return;
      if (mode === "create") await session.createRoom(choice);
      else await session.joinRoom(code, choice);
    });

  return (
    <Stack gap={10}>
      <SegmentedControl
        value={mode}
        onChange={(v) => setMode(v === "join" ? "join" : "create")}
        options={[
          { value: "create", label: "Create a room" },
          { value: "join", label: "Join a room" },
        ]}
      />
      {mode === "join" && (
        <Field label="Room code" hint="Ask whoever made the room for its code.">
          <TextInput value={code} onChange={setCode} placeholder="slc1-…" aria-label="Room code" />
        </Field>
      )}
      <Field label="Shared through">
        <SegmentedControl
          value={way}
          onChange={(v) => setWay(v === "relay" ? "relay" : "folder")}
          options={[
            { value: "folder", label: "Shared folder" },
            { value: "relay", label: "Relay" },
          ]}
        />
      </Field>
      {way === "folder" ? (
        <Field
          label="Folder"
          hint="A folder Google Drive, OneDrive, Dropbox, Syncthing or your NAS keeps the same on every computer. Everyone picks their own copy of it. It keeps the room's record; teammates also connect directly, so changes usually arrive at once."
        >
          <Button full onClick={() => void run(async () => setFolder((await session.pickFolder()) ?? folder))}>
            {folder ? folder.label : "Choose folder…"}
          </Button>
        </Field>
      ) : (
        <Field
          label="Relay address"
          hint="The relay your studio runs (see the extension's README). Changes arrive within a second or two."
        >
          <Stack gap={6}>
            <TextInput
              value={relay}
              onChange={(v) => {
                setRelay(v);
                setRelayAllowed(false);
              }}
              placeholder="https://relay.your-studio.com"
              aria-label="Relay address"
            />
            <Button
              disabled={!relayUrl || busy}
              onClick={() =>
                void run(async () => {
                  if (relayUrl) setRelayAllowed(await session.allowRelay(relayUrl));
                })
              }
            >
              {relayAllowed ? "Address allowed" : "Allow address"}
            </Button>
            {relay && !relayUrl && (
              <span style={{ fontSize: 10, color: ui.tokens.labelRed }}>The address must start with https://</span>
            )}
          </Stack>
        </Field>
      )}
      <Button
        variant="primary"
        full
        disabled={!choice || busy || (mode === "join" && !code.trim())}
        onClick={() => void submit()}
      >
        {mode === "create" ? "Create room" : "Join room"}
      </Button>
      {problem && <span style={{ fontSize: 11, color: ui.tokens.labelRed }}>{problem}</span>}
    </Stack>
  );
}
