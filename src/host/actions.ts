// What the app does beyond one controller: quit (kill the conversation, then the app's onQuit) and
// open another folder (check it, then the widecode controller's reopen). One app is open at a time,
// so the pending `/open` state lives here.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { expandHome } from "@lightstart/lib/paths.ts";
import hostController from "../controllers/host.ts";

let pendingOpen = "";
let pendingOpenAt = 0;
let opening = false;

/** Kill the conversation, then quit (the app's onQuit, set once mounted). */
export function quit(): void {
  const host = hostController.current;
  host.conversation.kill();
  const fn = host.onQuit;
  if (fn !== null) fn();
}

/**
 * Switch to another folder: the app starts again over it, with the same agent, CLI, model and
 * effort (the widecode controller's `reopen`). While the agent works, the first `/open` only warns.
 */
export async function openFolder(path: string): Promise<void> {
  const host = hostController.current;
  const target = resolve(host.workspace.folder, expandHome(path));
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    host.screen.tell("not a folder: " + target);
    return;
  }
  if (opening) {
    host.screen.tell("already opening a folder");
    return;
  }
  const now = Date.now();
  if (host.conversation.running && (pendingOpen !== target || now - pendingOpenAt > 10000)) {
    pendingOpen = target;
    pendingOpenAt = now;
    host.screen.tell(host.conversation.agent.name() + " is still working here: /open it again within 10 s to stop it and switch");
    return;
  }
  pendingOpen = "";
  const open = host.onOpen;
  if (open === null) {
    host.screen.tell("no folder can be opened here");
    return;
  }
  opening = true;
  try {
    await open(target);
  } finally {
    opening = false;
  }
}
