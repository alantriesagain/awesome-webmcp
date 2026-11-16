// widecode opened for a test, the one place a test builds the app: through the app layer, as the
// binary starts it (`openApp` over the generated manifest), with the widecode controller told the
// test's run instead of reading the flags: the folder's workspace, its conversation, the composition
// and the start with the plugins' config, without the log, the store or the config file. What a test
// changes before the start (the agent chosen, the CLI and its arguments, a store, a plugin folder)
// goes in `before`, which runs once the app is composed and before its plugins start. One app is
// open at a time: opening another stops the one before.
import type { StateFile } from "@lightstart/kernel/settings.ts";
import type { Plugin } from "@lightstart/kernel/plugin.ts";
import { openApp } from "@lightstart/app/test";
import type { OpenedApp } from "@lightstart/app/test";
import manifest from "../../.light/app.ts";
import type { Widecode } from "../../src/compose.ts";
import widecode, { Run } from "../../src/controllers/widecode.ts";

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

/** The app open now, stopped when the next one opens. */
let opened: OpenedApp | null = null;

/** widecode over `options.folder`, composed, started and loaded as the options say. */
export const openWidecode = async (options: OpenOptions): Promise<Widecode> => {
  if (opened !== null) {
    await opened.stop();
    opened = null;
  }
  const run = new Run();
  run.real = false;
  run.folder = options.folder;
  run.batchMs = options.batchMs ?? 100;
  run.plugins = options.plugins ?? null;
  if (options.state !== undefined) run.state = options.state;
  run.extra = options.extra ?? [];
  run.before = options.before ?? null;
  run.start = options.start ?? true;
  run.load = options.load ?? false;
  widecode.next = run;
  opened = await openApp(manifest, { storage: "memory" });
  return widecode.w;
};

/** Stop what `openWidecode` started: the agent's process, the plugins and their processes, the folder's watch. */
export const closeWidecode = (w: Widecode): void => {
  if (w === widecode.w) widecode.close();
};
