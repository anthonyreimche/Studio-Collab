// Runtime bindings. JSX in every module compiles (classic transform) to
// React.createElement, resolved against the `React` exported here: the
// instance Safelight passes to activate(). The bundle never imports React
// itself: Safelight loads it without an import map, and a second React would
// break hooks. The panel reaches the UI kit and the session through here too.

import type { CollabSession } from "./app/session";
import type { SafelightAPI } from "./safelight";

export let React!: SafelightAPI["react"];
export let ui!: SafelightAPI["ui"];
export let session!: CollabSession;

export function initRuntime(react: SafelightAPI["react"], kit: SafelightAPI["ui"], current: CollabSession): void {
  React = react;
  ui = kit;
  session = current;
}
