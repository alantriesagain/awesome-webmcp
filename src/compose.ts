// One start of widecode put together over the start's Host (controllers/host.ts): the shell, the
// native widgets the plugins mount (the chat and code columns, the Tools tab) and the JS plugins,
// built-in (plugins, in the binary), the user's and the project's, with the project's harness. `start` hands the kernel config.json's "plugins" and the state file, adds any
// extra compiled plugins after the JS ones (the tests' and the entry's), and starts them after what
// each requires, leaving out the ones switched off. What it returns holds the widgets for the
// entry, the selftest and the tests; plugins never reach each other this way, only through the host.
import { Host } from "./host/host.ts";
import { BUILTIN_PLUGINS } from "./runtime/builtin.ts";
import { JsRuntime } from "./runtime/runtime.ts";
import { Plugin } from "@lightstart/kernel/plugin.ts";
import type { StateFile } from "@lightstart/kernel/settings.ts";
import { mergeColumns, mergePlugins } from "./services/harness.ts";
import { Command } from "@lightstart/kernel/commands.ts";
import { PluginDefault } from "./services/store.ts";
import { ChatWidget } from "./views/chat-widget.ts";
import { CodeWidget } from "./views/code-widget.ts";
import { ToolsWidget } from "./views/tools-widget.ts";
import { Screen } from "@lightstart/light/native/tui";
import { Shell } from "./views/shell.ts";

export class Widecode {
  readonly host: Host;
  readonly shell: Shell;
  /** The chat column's widget, mounted by the chat plugin. */
  readonly chat: ChatWidget;
  /** The code column's widget, mounted by the code plugin. */
  readonly code: CodeWidget;
  /** The tools column's Tools tab, mounted by the tools plugin. */
  readonly tools: ToolsWidget;
  /** The JS plugins: built-in, the user's, the project's. */
  readonly js: JsRuntime;

  constructor(host: Host, shell: Shell) {
    this.host = host;
    this.shell = shell;
    this.chat = new ChatWidget(host);
    this.code = new CodeWidget(host);
    this.tools = new ToolsWidget(host);
    this.js = new JsRuntime(host);
    this.js.builtins = BUILTIN_PLUGINS.slice();
    this.js.code = this.code;
    this.js.chat = this.chat;
    this.js.tools = this.tools;
  }

  private prepared = false;
  /** The permission rules as the agent last got them, so a change fires harnessChanged. */
  private lastPermissions = "";

  /** The JS plugins in the kernel, not started. */
  private prepare(): void {
    if (this.prepared) return;
    this.prepared = true;
    this.js.load();
  }

  /** Each plugin's section as a new config.json gets it, the JS plugins' included. */
  defaults(): PluginDefault[] {
    this.prepare();
    return this.host.kernel.plugins.map((p) => new PluginDefault(p.id, p.defaults()));
  }

  /** Start: `plugins` is config.json's "plugins" (null for none), `state` what plugins keep, `extra` compiled plugins added after the JS ones. The keymap /keymap kept comes before the one the host was given (config.json's), before any plugin reads it. */
  start(plugins: unknown, state: StateFile, extra: Plugin[]): void {
    const k = this.host.kernel;
    this.host.session.userPlugins = plugins;
    k.settings.load(mergePlugins(plugins, this.host.harness.config().plugins));
    this.lastPermissions = this.host.session.permissions().rulesJson();
    k.settings.useStateFile(state);
    const kept = k.settings.state("keymap");
    if (typeof kept === "string" && kept.length > 0) this.host.keys.keymap = kept;
    this.prepare();
    for (const p of extra) k.use(p);
    k.start();
    for (const p of k.problems) this.host.note("plugin " + p);
    this.shell.finish();
    k.commands.add(new Command("/reload", "", "evaluate every JS plugin again (the agent restarts and resumes the session)", "plugins", (_arg: string) => this.js.reload()));
  }

  /** The columns' widths: the user's config with the project's over it; answers what could not be used. */
  configureColumns(columns: unknown): string {
    this.host.session.userColumns = columns;
    const note = this.shell.sizes.configure(mergeColumns(columns, this.host.harness.config().columns));
    this.host.screen.layout.value = this.host.screen.layout.peek() + 1;
    return note;
  }

  /** The painted `screen` as text: the named columns (every column for []) each cropped to its cells, the band under them included, the rows' trailing blanks dropped. */
  screenText(screen: Screen, columns: string[]): string {
    const ids = this.host.screen.columns.map((c) => c.id);
    const widths = this.shell.widths();
    let used = 0;
    for (const w of widths) used += w;
    const starts: number[] = [];
    const ends: number[] = [];
    let x = 0;
    for (let i = 0; i < ids.length; i++) {
      const w = widths[i] === 0 ? Math.max(0, screen.w - used) : widths[i];
      if (columns.length === 0 || columns.includes(ids[i])) {
        starts.push(x);
        ends.push(x + w);
      }
      x += w;
    }
    const rows: string[] = [];
    for (let y = 0; y < screen.h; y++) {
      let row = "";
      for (let i = 0; i < starts.length; i++) row += screen.rowText(y, starts[i], ends[i]);
      rows.push(row.replace(/\s+$/, ""));
    }
    while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
    return rows.join("\n");
  }

  /** The project's config read again over the user's: a plugin whose section or on/off changed starts again, the columns follow; answers a notice ("" for none). */
  applyHarness(): string {
    const k = this.host.kernel;
    const cfg = this.host.harness.config();
    const ids: string[] = [];
    for (const d of this.js.defs) if (!ids.includes(d.id)) ids.push(d.id);
    const offBefore = k.settings.switchedOff();
    const sectionsBefore: string[] = ids.map((id) => JSON.stringify(k.settings.section(id)));
    k.settings.load(mergePlugins(this.host.session.userPlugins, cfg.plugins));
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (offBefore.has(id) !== k.settings.isOff(id) || sectionsBefore[i] !== JSON.stringify(k.settings.section(id))) this.js.reloadPlugin(id);
    }
    const note = this.shell.sizes.configure(mergeColumns(this.host.session.userColumns, cfg.columns));
    this.host.screen.layout.value = this.host.screen.layout.peek() + 1;
    const permissions = this.host.session.permissions();
    if (permissions.rulesJson() !== this.lastPermissions) {
      this.lastPermissions = permissions.rulesJson();
      this.host.harnessChanged.fire();
    }
    return [cfg.notice, permissions.notice, note].filter((t) => t.length > 0).join("; ");
  }

  /** The project's own plugins folder among the plugin folders, watched; `sync` loads its files now. */
  useProjectPlugins(sync: boolean): void {
    const dir = this.host.harness.pluginsDir();
    if (!this.js.dirs.includes(dir)) this.js.dirs.push(dir);
    this.js.watchFolders();
    if (sync) this.js.syncFolder(dir);
  }

  /** Put the folder's harness in use without keeping the trust (`--trust`): its plugins, config and prompt. Answers what to tell ("" for nothing). */
  useHarnessNow(): string {
    this.host.session.setTrusted(true);
    this.useProjectPlugins(true);
    this.watchHarness();
    const note = this.applyHarness();
    this.host.harnessChanged.fire();
    return note;
  }

  /** Trust the folder from now on: the agent works here (one that starts at launch starts now), and its harness is put in use: its plugins, its prompt, its config. Answers what to tell ("" without a store). */
  trust(): string {
    const h = this.host;
    const store = h.session.store;
    if (store === null) return "";
    store.trust(h.workspace.folder);
    const wasTrusted = h.session.trusted.peek();
    const note = this.useHarnessNow();
    if (!wasTrusted) h.conversation.prepare();
    return "trusted: " + h.conversation.agent.name() + " works here and the folder's harness is in use" + (note.length > 0 ? " (" + note + ")" : "");
  }

  /** Follow the project's harness folder: its plugins reload as they change, its config is applied, its prompt reaches the agent at the next start. */
  watchHarness(): void {
    const h = this.host;
    h.harness.onChange = (what: string) => {
      if (!h.harness.trusted) return;
      if (what === "plugins") this.useProjectPlugins(true);
      else if (what === "config") {
        const note = this.applyHarness();
        h.screen.tell(note.length > 0 ? note : "the harness config applied");
      } else h.harnessChanged.fire();
    };
    h.harness.watch();
  }
}

/** widecode over the start's `host`, not started. */
export const composeWidecode = (host: Host): Widecode => new Widecode(host, new Shell());
