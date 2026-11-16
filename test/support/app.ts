// widecode opened for a test, the one place a test builds the app: the folder's workspace, its
// conversation, the composition and the start with the plugins' config. What a test changes before
// the start (the agent chosen, the CLI and its arguments, a store, a plugin folder) goes in `before`,
// which runs once the app is composed and before its plugins start. The app's own startup (the
// widecode controller) is what a selftest runs; this is the same composition without the terminal.
import { NoStateFile } from "@lightstart/kernel/settings.ts";
import type { StateFile } from "@lightstart/kernel/settings.ts";
import type { Plugin } from "@lightstart/kernel/plugin.ts";
import { openWorkspace } from "@lightstart/workspace/workspace.ts";
import { Conversation } from "../../src/conversation/conversation.ts";
import { composeWidecode, Widecode } from "../../src/compose.ts";

/** What a test opens widecode with; every field but `folder` has a default. */
export interface OpenOptions {
  /** The folder the app opens. */
  folder: string;
  /** How long the folder's events gather, in ms; 100 by default. */
  batchMs?: number;
  /** config.json's "plugins": null (the default) for none. */
  plugins?: unknown;
  /** What plugins keep between runs; nothing by default. */
  state?: StateFile;
  /** Compiled plugins added after the JS ones. */
  extra?: Plugin[];
  /** Run once the app is composed, before its plugins start. */
  before?: (w: Widecode) => void | Promise<void>;
  /** Whether the plugins start; true by default. A test that starts them itself says false. */
  start?: boolean;
  /** Whether the folder's files and status are read before the app is answered; false by default. */
  load?: boolean;
}

/** widecode over `options.folder`, composed, started and loaded as the options say. */
export const openWidecode = async (options: OpenOptions): Promise<Widecode> => {
  const workspace = await openWorkspace(options.folder, options.batchMs ?? 100);
  const w = composeWidecode(workspace, new Conversation(workspace.folder));
  const before = options.before;
  if (before !== undefined) await before(w);
  if (options.start ?? true) w.start(options.plugins ?? null, options.state ?? new NoStateFile(), options.extra ?? []);
  if (options.load ?? false) await w.host.load();
  return w;
};

/** Stop what `openWidecode` started: the agent's process, the plugins and their processes, the folder's watch. */
export const closeWidecode = (w: Widecode): void => {
  w.host.conversation.kill();
  w.host.kernel.stop();
  w.js.killProcesses();
  w.host.workspace.close();
};
