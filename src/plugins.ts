// One start's JS plugins: the runtime over the start's host, the built-in, user and project plugins
// it loads, their defaults and their start, and the project's plugin folder. Made fresh each start
// by the plugins controller (controllers/plugins.ts) and reached through it.
import { Host } from "./host/host.ts";
import { AgentHarness } from "./host/session.ts";
import { JsRuntime } from "./runtime/runtime.ts";
import { Plugin } from "@lightstart/kernel/plugin.ts";
import type { StateFile } from "@lightstart/kernel/settings.ts";
import { mergePlugins } from "./services/harness.ts";
import { Command } from "@lightstart/kernel/commands.ts";
import { PluginDefault } from "./services/store.ts";

export class Plugins {
  readonly host: Host;
  /** The JS plugins: built-in, the user's, the project's. */
  readonly js: JsRuntime;
  private prepared = false;
  private closed = false;

  constructor(host: Host) {
    this.host = host;
    this.js = new JsRuntime(host);
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

  /** Stop what this start opened: the plugins' processes, their folders' watches, the MCP server. Once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.js.killProcesses();
    this.js.stopWatching();
    this.js.mcp.close();
  }
}
