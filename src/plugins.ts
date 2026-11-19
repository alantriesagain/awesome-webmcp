// One start's JS plugins: the runtime over the start's host, the built-in, user and project plugins
// it loads, their defaults and their start, and the project's plugin folder. Made fresh each start
// by the plugins controller (controllers/plugins.ts) and reached through it.
import { Host } from "./host/host.ts";
import { AgentHarness } from "./host/session.ts";
import { JsRuntime } from "./runtime/runtime.ts";
import { Plugin } from "@lightstart/kernel/plugin.ts";
import type { StateFile } from "@lightstart/kernel/settings.ts";
import { mergeColumns, mergePlugins } from "./services/harness.ts";
import { Command } from "@lightstart/kernel/commands.ts";
import { PluginDefault } from "./services/store.ts";
import { ChatWidget } from "./views/chat-widget.ts";
import { CodeWidget } from "./views/code-widget.ts";
import { ToolsWidget } from "./views/tools-widget.ts";

export class Plugins {
  readonly host: Host;
  /** The chat column's widget, mounted by the chat plugin. */
  readonly chat: ChatWidget;
  /** The code column's widget, mounted by the code plugin. */
  readonly code: CodeWidget;
  /** The tools column's Tools tab, mounted by the tools plugin. */
  readonly tools: ToolsWidget;
  /** The JS plugins: built-in, the user's, the project's. */
  readonly js: JsRuntime;
  /** Set by the shell's owner to take the columns' widths; answers what it could not use. */
  configureSizes: ((columns: unknown) => string) | null = null;
  private prepared = false;
  private closed = false;

  constructor(host: Host) {
    this.host = host;
    this.chat = new ChatWidget();
    this.code = new CodeWidget();
    this.tools = new ToolsWidget();
    this.js = new JsRuntime(host);
    this.js.code = this.code;
    this.js.chat = this.chat;
    this.js.tools = this.tools;
  }

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
    this.noteHarness();
    k.settings.useStateFile(state);
    const kept = k.settings.state("keymap");
    if (typeof kept === "string" && kept.length > 0) this.host.keys.keymap.value = kept;
    const mode = k.settings.state("approval");
    if (typeof mode === "string") this.host.approval.set(mode);
    this.prepare();
    for (const p of extra) k.use(p);
    k.start();
    for (const p of k.problems) this.host.note("plugin " + p);
    k.commands.add(new Command("/reload", "", "evaluate every JS plugin again (the agent restarts and resumes the session)", "plugins", (_arg: string) => this.js.reload()));
  }

  /** The /trust command, per start (the kernel is new each start); the widecode controller adds it after /log. */
  registerCommands(): void {
    const commands = this.host.kernel.commands;
    commands.add(new Command("/trust", "", "trust this folder: the agent works here and its own harness (.widecode: plugins, prompt, config) runs, now and on every launch", "plugins", (_arg: string) => this.trustHere()));
  }

  /** The /trust action and onboarding's trust answer: trust the folder from now on, saying so ("" without a store). */
  trustHere(): void {
    const note = this.trust();
    if (note.length > 0) this.host.screen.tell(note);
  }

  /** The project's own plugins folder among the plugin folders, watched; `sync` loads its files now. */
  useProjectPlugins(sync: boolean): void {
    const dir = this.host.harness.pluginsDir();
    if (!this.js.dirs.includes(dir)) this.js.dirs.push(dir);
    this.js.watchFolders();
    if (sync) this.js.syncFolder(dir);
  }

  /** Note what the harness gives the agent now; plugins hear harnessChanged when any of it changed. */
  noteHarness(): void {
    const h = this.host.harness;
    this.host.session.useHarness(new AgentHarness(this.host.session.permissions().rulesJson(), h.userPrompt(), h.prompt(), this.host.session.trusted.peek()));
  }

  /** The columns' widths: the user's config with the project's over it; answers what could not be used. */
  private useColumns(): string {
    const note = this.configureSizes !== null ? this.configureSizes(mergeColumns(this.host.session.userColumns, this.host.harness.config().columns)) : "";
    this.host.screen.layout.value = this.host.screen.layout.peek() + 1;
    return note;
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
    const note = this.useColumns();
    const permissions = this.host.session.permissions();
    this.noteHarness();
    return [cfg.notice, permissions.notice, note].filter((t) => t.length > 0).join("; ");
  }

  /** Put the folder's harness in use without keeping the trust (`--trust`): its plugins, config and prompt. Answers what to tell ("" for nothing). */
  useHarnessNow(): string {
    this.host.session.setTrusted(true);
    this.useProjectPlugins(true);
    this.watchHarness();
    return this.applyHarness();
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
      } else this.noteHarness();
    };
    h.harness.watch();
  }

  /** Stop what this start opened: the plugins' processes, their folders' watches, the MCP server. Once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.js.killProcesses();
    this.js.stopWatching();
    this.js.mcp.close();
  }
}
