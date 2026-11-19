// The hooks plugins listen to: the one list of them, built once per start over the controllers whose
// state they announce (the session, the folder, the keymaps, the approval mode and the screen), and
// the lookups by name. The app's Host forwards its own `hooks`/`hook`/`replay` here, so widecode.d.ts,
// PLUGINS.md and the plugins hear the same list.
import { type Emitter, computed } from "@lightstart/light/signals";
import type { FolderController } from "@lightstart/workspace/folder.ts";
import type { ScreenController } from "../screen/screen.ts";
import type { KeymapController } from "./keymaps.ts";
import type { ApprovalController } from "./approval.ts";
import type { SessionController } from "./session.ts";
import { hookOn, hookOnEvent } from "./after-change.ts";

/** A hook plugins listen to (an event their listeners join under their own name), and the name they listen to it under. */
export class NamedHook {
  readonly name: string;
  readonly hook: Emitter<unknown>;

  constructor(name: string, hook: Emitter<unknown>) {
    this.name = name;
    this.hook = hook;
  }
}

/** The hooks of this start, over the controllers it built. */
export const buildHooks = (session: SessionController, folder: FolderController, keys: KeymapController, approval: ApprovalController, screen: ScreenController): NamedHook[] => [
  new NamedHook("conversationChanged", hookOn("conversationChanged", session.conversationState)),
  new NamedHook("sessionsChanged", hookOn("sessionsChanged", computed(() => [session.sessionRows.value, session.skillRows.value]))),
  new NamedHook("filesLoaded", hookOn("filesLoaded", folder.files)),
  new NamedHook("statusLoaded", hookOn("statusLoaded", folder.status)),
  new NamedHook("folderChanged", hookOnEvent(folder.changed)),
  new NamedHook("baseChanged", hookOn("baseChanged", folder.base)),
  new NamedHook("fileShown", hookOn("fileShown", screen.shown)),
  new NamedHook("requestOpened", session.requestOpened),
  new NamedHook("messageSending", session.messageSending),
  new NamedHook("keymapChanged", hookOn("keymapChanged", keys.keymap)),
  new NamedHook("approvalChanged", hookOn("approvalChanged", approval.approval)),
  new NamedHook("messageChanged", hookOn("messageChanged", screen.message)),
  new NamedHook("toolsChanged", hookOn("toolsChanged", session.tools)),
  new NamedHook("harnessChanged", hookOn("harnessChanged", session.harnessState)),
];

/** The hook plugins listen to under `name`; null for an unknown name. */
export const hookOf = (hooks: NamedHook[], name: string): Emitter<unknown> | null => {
  const found = hooks.find((n) => n.name === name);
  return found !== undefined ? found.hook : null;
};

/** Fire hook `name` again, so plugins started since catch up with the state the others saw. */
export const replayHook = (hooks: NamedHook[], name: string): void => {
  hookOf(hooks, name)?.emit(undefined);
};
