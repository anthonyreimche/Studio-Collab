// Words the panel and the presence bar share.

import type { Stage } from "../sync/catalog-sync";
import type { Role } from "../sync/payload";
import type { MemberView } from "../sync/engine";

export const ROLE_LABELS: Record<Role, string> = {
  shooter: "Shooter",
  culler: "Culler",
  editor: "Editor",
  exporter: "Exporter",
};

export const STAGE_LABELS: Record<Stage, string> = {
  shot: "Shot",
  culled: "Culled",
  edited: "Edited",
  exported: "Exported",
};

/** "just now", "40 s ago", "3 min ago", "2 h ago". */
export function ago(at: number | null, now: number): string {
  if (at === null) return "not yet";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

/** How far ahead a clock runs, in words. */
export function ahead(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/** How a teammate's changes reach this computer, in words: "direct, 12 ms",
 *  "relay" or "via folder, slower", and whether a direct connection is
 *  being set up meanwhile. */
export function linkLabel(m: Pick<MemberView, "link" | "rttMs" | "connecting">): string {
  if (m.link === "direct") return m.rttMs === null ? "direct" : `direct, ${m.rttMs} ms`;
  const path = m.link === "relay" ? "relay" : "via folder, slower";
  return m.connecting ? `${path} (connecting directly…)` : path;
}

/** What a member is doing, from its module and whether it is editing. */
export function activity(module: string, editing: boolean, role: Role | ""): string {
  if (editing) return "editing";
  if (module === "library") return role === "culler" || role === "" ? "culling" : "browsing";
  if (module === "develop") return "looking at";
  return module ? `in ${module}` : "here";
}
