// A read-only view of one start of widecode: the start's Host, its Shell and the widgets and JS
// plugins the plugins controller (controllers/plugins.ts) built. It holds nothing of its own and
// does nothing: every member is a getter or a one-line delegation to where the work now is. It is
// what src/run.ts, src/selftest.ts and the tests read; the app itself reaches the controllers.
import { Host } from "./host/host.ts";
import pluginsController from "./controllers/plugins.ts";
import { JsRuntime } from "./runtime/runtime.ts";
import { Plugin } from "@lightstart/kernel/plugin.ts";
import type { StateFile } from "@lightstart/kernel/settings.ts";
import { PluginDefault } from "./services/store.ts";
import { ChatWidget } from "./views/chat-widget.ts";
import { CodeWidget } from "./views/code-widget.ts";
import { ToolsWidget } from "./views/tools-widget.ts";
import { Screen } from "@lightstart/light/native/tui";
import { Shell } from "./views/shell.ts";

export class Widecode {
  readonly host: Host;
  readonly shell: Shell;

  constructor(host: Host, shell: Shell) {
    this.host = host;
    this.shell = shell;
  }

  /** The chat column's widget, mounted by the chat plugin. */
  get chat(): ChatWidget {
    return pluginsController.current.chat;
  }
  /** The code column's widget, mounted by the code plugin. */
  get code(): CodeWidget {
    return pluginsController.current.code;
  }
  /** The tools column's Tools tab, mounted by the tools plugin. */
  get tools(): ToolsWidget {
    return pluginsController.current.tools;
  }
  /** The JS plugins: built-in, the user's, the project's. */
  get js(): JsRuntime {
    return pluginsController.current.js;
  }

  /** Each plugin's section as a new config.json gets it, the JS plugins' included. */
  defaults(): PluginDefault[] {
    return pluginsController.current.defaults();
  }

  /** Start: `plugins` is config.json's "plugins" (null for none), `state` what plugins keep, `extra` compiled plugins added after the JS ones. */
  start(plugins: unknown, state: StateFile, extra: Plugin[]): void {
    pluginsController.current.start(plugins, state, extra);
    this.shell.finish();
  }

  /** The columns' widths: the user's config with the project's over it; answers what could not be used. */
  configureColumns(columns: unknown): string {
    return this.shell.configureColumns(columns);
  }

  /** The painted `screen` as text: the named columns (every column for []) each cropped to its cells, the band under them included, the rows' trailing blanks dropped. */
  screenText(screen: Screen, columns: string[]): string {
    return this.shell.screenText(screen, columns);
  }

  /** The project's config read again over the user's: a plugin whose section or on/off changed starts again, the columns follow; answers a notice ("" for none). */
  applyHarness(): string {
    return pluginsController.current.applyHarness();
  }

  /** The project's own plugins folder among the plugin folders, watched; `sync` loads its files now. */
  useProjectPlugins(sync: boolean): void {
    pluginsController.current.useProjectPlugins(sync);
  }

  /** Put the folder's harness in use without keeping the trust (`--trust`): its plugins, config and prompt. Answers what to tell ("" for nothing). */
  useHarnessNow(): string {
    return pluginsController.current.useHarnessNow();
  }

  /** Trust the folder from now on: the agent works here (one that starts at launch starts now), and its harness is put in use: its plugins, its prompt, its config. Answers what to tell ("" without a store). */
  trust(): string {
    return pluginsController.current.trust();
  }

  /** Follow the project's harness folder: its plugins reload as they change, its config is applied, its prompt reaches the agent at the next start. */
  watchHarness(): void {
    pluginsController.current.watchHarness();
  }
}

/** widecode over the start's `host` and `shell`, not started. */
export const composeWidecode = (host: Host, shell: Shell): Widecode => new Widecode(host, shell);
