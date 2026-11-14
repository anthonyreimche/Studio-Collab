// One line under the Library toolbar: who else is working now and on what.

import { React, session, ui } from "../rt";
import { activity } from "./format";
import { useSessionView } from "./CollabPanel";

export function PresenceBar() {
  const { tokens } = ui;
  const view = useSessionView();
  const here = (view.engine?.members ?? []).filter((m) => m.fresh);
  if (view.phase !== "running" || here.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 14,
        padding: "3px 10px",
        fontSize: 11,
        color: tokens.textSecondary,
        borderBottom: `1px solid ${tokens.borderSubtle}`,
        overflow: "hidden",
        whiteSpace: "nowrap",
      }}
    >
      {here.map((m) => (
        <span key={m.id} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: m.editing ? tokens.labelYellow : tokens.labelGreen }} />
          <span style={{ color: tokens.textPrimary }}>{m.name}</span>
          {m.photo && (
            <span>
              {activity(m.module, m.editing, m.role)} {session.photoNameFor(m.photo)}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
