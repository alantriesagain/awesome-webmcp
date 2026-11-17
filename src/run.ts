// What one start of the app is: a Run, the real app's or a test's, and what carries over to it from
// the start before (an /open). The run controller (controllers/run.ts) holds the start's own.
import { NoStateFile } from "@lightstart/kernel/settings.ts";
import type { StateFile } from "@lightstart/kernel/settings.ts";
import type { Plugin } from "@lightstart/kernel/plugin.ts";
import type { Widecode } from "./compose.ts";

/** How long folder events gather before the screen refreshes. */
export const CHANGES_MS = 150;

/**
 * How one start of the app goes: the real app's (`real`, the rest read from the flags), or a test's,
 * which opens its folder without the log, the store or the config, and starts the plugins as it says.
 */
export class Run {
  /** The folder the app opens. */
  folder = "";
  /** How long the folder's events gather, in ms. */
  batchMs = CHANGES_MS;
  /** The real app: the log, the signals, the store and the config. A test's run has none of them. */
  real = true;
  /** A test's: config.json's "plugins" (null for none), what plugins keep, compiled plugins after the JS ones. */
  plugins: unknown = null;
  state: StateFile = new NoStateFile();
  extra: Plugin[] = [];
  /** A test's: run once the app is composed, before its plugins start. */
  before: ((w: Widecode) => void | Promise<void>) | null = null;
  /** A test's: whether the plugins start, and whether the folder is read before the start settles. */
  start = true;
  load = false;
  /** Where the built-in plugins are read from ("" for the ones the binary carries). */
  builtinDir = "";

  /** The same run over another folder, read once it starts (an `/open`). */
  over(folder: string): Run {
    const next = new Run();
    next.folder = folder;
    next.batchMs = this.batchMs;
    next.real = this.real;
    next.plugins = this.plugins;
    next.state = this.state;
    next.extra = this.extra;
    next.before = this.before;
    next.start = this.start;
    next.load = true;
    next.builtinDir = this.builtinDir;
    return next;
  }
}

/** What carries over to another folder (`/open`): the agent chosen, its CLI and arguments, the model and the effort. */
export class Carry {
  agentId = "";
  executable = "";
  extraArgs: string[] = [];
  modelName = "";
  effort = "";
  /** What the new start tells, once it runs. */
  notice = "";
}
