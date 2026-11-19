// widecode's own data, what Claude Code does not keep. Global, in ~/.widecode (or $WIDECODE_HOME):
// `config.json`, the settings: a "plugins" object with each plugin's section (false switches it
// off), written with every plugin's defaults on first run so it can be edited; `state.json`, what
// plugins keep between runs; and `limits.json`, each agent's last rate-limit windows, so the status
// bar has them at start and another agent's are not shown for it. Per
// project, in `<folder>/.widecode/sessions/<id>.json`, so it travels with the project: a session's
// title and what widecode measured (cost across CLI processes, thinking tokens); `.widecode/` holds a
// `.gitignore` of `*`, so git (and so the changes widecode shows) leaves it out. Files are written
// whole and renamed into place. Natively `JSON.stringify` refuses class instances, so
// values are written as literals typed `unknown`, and read back through all-`unknown` interfaces.
import { Limits } from "../conversation/session-store.ts";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { errorMessage, isRecord, recordOf, text } from "@lightstart/lib/json.ts";
import { readTextOr, writeAtomic } from "@lightstart/lib/fs.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { StateFile } from "@lightstart/kernel/settings.ts";
import { LimitsStore } from "./limits.ts";
import { TrustStore } from "./trust.ts";

/** A plugin's section as a new config.json gets it. */
export class PluginDefault {
  readonly id: string;
  readonly value: unknown;

  constructor(id: string, value: unknown) {
    this.id = id;
    this.value = value;
  }
}

/** Where this run's log goes: on unless config.json's "log" says otherwise, in the store's logs folder unless `dir` names another, the newest `keep` runs' files kept. */
export class LogConfig {
  enabled = true;
  /** Its folder: "" for the store's `logs`, else a path (`~/` for the home folder, a relative one from the store's). */
  dir = "";
  keep = 30;
}

export class Config {
  /** The "plugins" object as read (null: none, every plugin on with its defaults). */
  plugins: unknown = null;
  /** How copying reaches the clipboard: "auto", "osc52" or "xclip" (@lightstart/tui/clipboard.ts). */
  clipboard = "auto";
  /** The columns' widths, as written (null: none set; shell/column-widths.ts reads it). */
  columns: unknown = null;
  /** The agent the conversation talks to: "claude", or one a plugin brings ("" for the default). */
  agent = "";
  /** The keymap: "default", or one a plugin brings ("" for the default; what /keymap kept in state.json comes before it). */
  keymap = "";
  /** Tool permission rules in Claude Code's syntax, as written: { allow, ask, deny } (null: none). */
  permissions: unknown = null;
  /** This run's log: `"log": false`, `true`, or `{ "enabled", "dir", "keep" }`. */
  log = new LogConfig();
  /** The memory the plugins' engine may hold, in MB: `"pluginMemoryMb"`, at least 16. */
  pluginMemoryMb = 256;
  /** Why the file was not used as written, or what was moved in it ("" for neither). */
  notice = "";
  /** There was no config.json: `seedConfig` writes one with the plugins' sections. */
  missing = false;
}

/** Everything read from the store's JSON, every field `unknown`. */
interface Fields {
  plugins?: unknown;
  clipboard?: unknown;
  columns?: unknown;
  permissions?: unknown;
  log?: unknown;
  enabled?: unknown;
  dir?: unknown;
  keep?: unknown;
  agent?: unknown;
  keymap?: unknown;
  pluginMemoryMb?: unknown;
  titles?: unknown;
  models?: unknown;
  statusline?: unknown;
  auto?: unknown;
  model?: unknown;
  id?: unknown;
  folder?: unknown;
  title?: unknown;
  titleBy?: unknown;
  createdMs?: unknown;
  updatedMs?: unknown;
  costUsd?: unknown;
  thinkingTokens?: unknown;
  effort?: unknown;
  contextWindow?: unknown;
  baseCommit?: unknown;
  file?: unknown;
  fiveHour?: unknown;
  sevenDay?: unknown;
  usedPercent?: unknown;
  resetsAt?: unknown;
}

const fields = (v: unknown): Fields | null => (isRecord(v) ? (v as Fields) : null);

/** config.json's "log": false turns it off, true or nothing leaves it on, an object sets `enabled`, `dir` and `keep` (at least 1); what is not of its type is left at its default. */
const logConfigOf = (v: unknown): LogConfig => {
  const c = new LogConfig();
  if (v === false) c.enabled = false;
  const f = fields(v);
  if (f === null) return c;
  if (typeof f.enabled === "boolean") c.enabled = f.enabled;
  if (typeof f.dir === "string") c.dir = f.dir.trim();
  if (typeof f.keep === "number" && Number.isFinite(f.keep) && f.keep >= 1) c.keep = Math.floor(f.keep);
  return c;
};

/**
 * config.json's text for plugin sections `ids` and `values`, built as text: natively an object
 * written by computed string keys slows every call. `root`, on a migration, keeps every top-level
 * key the move does not rewrite (`plugins`) or remove (`statusline`, `titles`, `models`).
 */
const configText = (ids: string[], values: unknown[], root: Record<string, unknown> | null = null): string => {
  const parts: string[] = [];
  if (root !== null)
    for (const key of Object.keys(root)) {
      if (key === "plugins" || key === "statusline" || key === "titles" || key === "models") continue;
      const written = JSON.stringify(root[key], null, 2);
      if (written !== undefined) parts.push("  " + JSON.stringify(key) + ": " + written.split("\n").join("\n  "));
    }
  let clipboard = false;
  for (const p of parts) if (p.startsWith('  "clipboard":')) clipboard = true;
  if (!clipboard) parts.unshift('  "clipboard": "auto"');
  if (root === null) parts.push('  "log": { "enabled": true, "keep": 30 }');
  const sections: string[] = [];
  for (let i = 0; i < ids.length; i++) sections.push("    " + JSON.stringify(ids[i]) + ": " + JSON.stringify(values[i], null, 2).split("\n").join("\n    "));
  parts.push("  \"plugins\": {\n" + sections.join(",\n") + "\n  }");
  return "{\n" + parts.join(",\n") + "\n}\n";
};

/** What plugins keep between runs, in the store's state.json. */
class StoreStateFile extends StateFile {
  readonly path: string;

  constructor(path: string) {
    super();
    this.path = path;
  }

  read(): string {
    return readTextOr(this.path, "");
  }

  write(text: string): void {
    writeAtomic(this.path, text);
  }
}

export class Store {
  readonly root: string;
  /** The trusted folders, and the last rate-limit windows seen. */
  readonly trustStore: TrustStore;
  readonly limitsStore: LimitsStore;
  /** Whether loadConfig wrote config.json because there was none: widecode's first run with this store. */
  firstRun = false;

  constructor(root: string) {
    this.root = root;
    this.trustStore = new TrustStore(root);
    this.limitsStore = new LimitsStore(root);
  }

  static defaultRoot(): string {
    const env = process.env["WIDECODE_HOME"] ?? "";
    return env.length > 0 ? env : join(homedir(), ".widecode");
  }

  /**
   * Move what an earlier version kept in `oldRoot` (~/.ctui: config, limits, and every session's
   * record) to this store, each session's record into its project's .widecode/, then remove
   * `oldRoot` when every record moved. A record that cannot be read or written stays in `oldRoot`,
   * which stays with it. Does nothing once this store has a config. Answers what it did ("" for
   * nothing).
   */
  migrateFrom(oldRoot: string): string {
    if (!existsSync(oldRoot) || existsSync(this.configPath)) return "";
    mkdirSync(this.root, { recursive: true });
    for (const name of ["config.json", "limits.json"]) {
      const raw = this.read(join(oldRoot, name));
      if (raw.length > 0) writeAtomic(join(this.root, name), raw);
    }
    let moved = 0;
    let stayed = 0;
    const dir = join(oldRoot, "sessions");
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const raw = this.read(join(dir, name));
      let value: unknown = null;
      try {
        value = JSON.parse(raw);
      } catch {
        stayed++;
        continue;
      }
      const f = fields(value);
      const folder = f !== null ? text(f.folder, "") : "";
      let isDir = false;
      try {
        isDir = folder.length > 0 && statSync(folder).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        stayed++;
        continue;
      }
      const target = join(folder, ".widecode", "sessions", name);
      if (existsSync(target)) continue;
      try {
        mkdirSync(join(folder, ".widecode", "sessions"), { recursive: true });
        writeFileSync(target, raw);
      } catch {
        stayed++;
        continue;
      }
      moved++;
    }
    let left = "";
    if (stayed > 0) left = "; " + String(stayed) + (stayed === 1 ? " record stayed in " : " records stayed in ") + oldRoot;
    else {
      try {
        rmSync(oldRoot, { recursive: true, force: true });
      } catch (err) {
        left = "; cannot remove " + oldRoot + ": " + (errorMessage(err, "error"));
      }
    }
    return "moved " + oldRoot + " to " + this.root + (moved > 0 ? " and " + String(moved) + " session records into their projects" : "") + left;
  }

  private writeText(path: string, text: string): void {
    writeAtomic(path, text);
  }

  private read(path: string): string {
    return readTextOr(path, "");
  }

  get configPath(): string {
    return join(this.root, "config.json");
  }

  /** The user's key bindings, `keys.json` beside the config, as text ("" for none). */
  readKeys(): string {
    const path = join(this.root, "keys.json");
    if (!existsSync(path)) return "";
    try {
      return this.read(path);
    } catch {
      return "";
    }
  }

  /** The settings, read (`readConfig`), and on first run written with every plugin's default section (`seedConfig`). */
  loadConfig(defaults: PluginDefault[]): Config {
    const c = this.readConfig();
    this.seedConfig(c, defaults);
    return c;
  }

  /**
   * On first run (no config.json when `c` was read), write one with every plugin's default
   * section (`defaults`) for editing; `c` takes its plugins. Nothing otherwise.
   */
  seedConfig(c: Config, defaults: PluginDefault[]): void {
    if (!c.missing) return;
    c.missing = false;
    const ids: string[] = [];
    const values: unknown[] = [];
    for (const d of defaults) {
      ids.push(d.id);
      values.push(d.value);
    }
    const text = configText(ids, values);
    try {
      this.writeText(this.configPath, text);
      this.firstRun = true;
    } catch (err) {
      c.notice = "cannot write " + this.configPath + ": " + (errorMessage(err, "error"));
    }
    c.plugins = (JSON.parse(text) as Fields).plugins;
  }

  /**
   * The settings as config.json has them; without one, the defaults and `missing` (the plugins'
   * sections come with `seedConfig`, once the plugins are known). A file from before plugins
   * (top-level "statusline", "titles", "models") has them moved under "plugins" once, into the
   * status, sessions and models sections.
   */
  readConfig(): Config {
    const c = new Config();
    if (!existsSync(this.configPath)) {
      c.missing = true;
      return c;
    }
    let value: unknown = null;
    try {
      value = JSON.parse(this.read(this.configPath));
    } catch (err) {
      c.notice = "config.json is not valid JSON (" + (errorMessage(err, "error")) + "); using the defaults";
      return c;
    }
    const root = fields(value);
    if (root === null) {
      c.notice = "config.json is not an object; using the defaults";
      return c;
    }
    if (typeof root.clipboard === "string") c.clipboard = root.clipboard;
    if (root.columns !== undefined) c.columns = root.columns;
    if (typeof root.agent === "string") c.agent = root.agent;
    if (typeof root.keymap === "string") c.keymap = root.keymap;
    if (root.permissions !== undefined) c.permissions = root.permissions;
    c.log = logConfigOf(root.log);
    if (root.pluginMemoryMb !== undefined) {
      if (typeof root.pluginMemoryMb === "number" && Number.isFinite(root.pluginMemoryMb) && root.pluginMemoryMb >= 16) c.pluginMemoryMb = Math.floor(root.pluginMemoryMb);
      else c.notice = "config.json's \"pluginMemoryMb\" is a number of megabytes, at least 16; using " + String(c.pluginMemoryMb);
    }
    if (root.statusline === undefined && root.titles === undefined && root.models === undefined) {
      c.plugins = root.plugins === undefined ? null : root.plugins;
      return c;
    }
    // From before plugins: the old keys move under "plugins", next to what is there already.
    const ids: string[] = [];
    const values: unknown[] = [];
    const present = root.plugins !== undefined && isRecord(root.plugins) ? (root.plugins as Record<string, unknown>) : null;
    if (present !== null)
      for (const id of Object.keys(present)) {
        ids.push(id);
        values.push(present[id]);
      }
    const move = (id: string, v: unknown): void => {
      const at = ids.indexOf(id);
      if (at < 0) {
        ids.push(id);
        values.push(v);
      } else if (values[at] === true) values[at] = v;
    };
    const titles = fields(root.titles);
    if (titles !== null) {
      const v: unknown = { titles: titles.auto !== false, titleModel: typeof titles.model === "string" ? titles.model : "haiku" };
      move("sessions", v);
    }
    if (Array.isArray(root.models)) {
      const v: unknown = { list: root.models };
      move("models", v);
    }
    if (root.statusline !== undefined) move("status", root.statusline);
    const raw = value as { [key: string]: unknown };
    const text = configText(ids, values, raw);
    try {
      this.writeText(this.configPath, text);
      c.notice = "config.json: the status table, titles and models moved under \"plugins\"";
    } catch (err) {
      c.notice = "cannot write " + this.configPath + ": " + (errorMessage(err, "error"));
    }
    c.plugins = (JSON.parse(text) as Fields).plugins;
    return c;
  }

  /** Whether the user trusts `folder`: the agent works there, and its own harness (.widecode) runs. */
  trusted(folder: string): boolean {
    return this.trustStore.trusted(folder);
  }

  /** Trust `folder` from now on. */
  trust(folder: string): void {
    this.trustStore.trust(folder);
  }

  /** Set top-level `key` of config.json to `value`, the other keys as they are; "" or why not. */
  setConfigValue(key: string, value: unknown): string {
    let root: Record<string, unknown> | null = null;
    if (existsSync(this.configPath)) {
      try {
        const v = JSON.parse(this.read(this.configPath)) as unknown;
        root = recordOf(v);
      } catch (err) {
        return "config.json is not valid JSON (" + (errorMessage(err, "error")) + ")";
      }
      if (root === null) return "config.json is not an object";
    }
    const keys: string[] = [];
    const values: string[] = [];
    if (root !== null)
      for (const k of Object.keys(root)) {
        keys.push(k);
        values.push(JSON.stringify(root[k], null, 2));
      }
    const at = keys.indexOf(key);
    if (at >= 0) values[at] = JSON.stringify(value, null, 2);
    else {
      keys.push(key);
      values.push(JSON.stringify(value, null, 2));
    }
    const parts: string[] = [];
    for (let i = 0; i < keys.length; i++) parts.push("  " + JSON.stringify(keys[i]) + ": " + values[i].split("\n").join("\n  "));
    try {
      this.writeText(this.configPath, "{\n" + parts.join(",\n") + "\n}\n");
    } catch (err) {
      return "cannot write " + this.configPath + ": " + (errorMessage(err, "error"));
    }
    return "";
  }

  /** The user's plugin folder. */
  pluginsDir(): string {
    return join(this.root, "plugins");
  }

  /** Where plugins keep what lasts between runs. */
  stateFile(): StateFile {
    return new StoreStateFile(join(this.root, "state.json"));
  }



  /** Make `folder`'s .widecode/ ignore itself in git (`create`: make the folder when it is missing). */
  ignoreIn(folder: string, create: boolean): void {
    const dir = join(folder, ".widecode");
    const ignore = join(dir, ".gitignore");
    if (existsSync(ignore) || (!create && !existsSync(dir))) return;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(ignore, "# widecode's own data (session titles, costs): not part of the project.\n*\n");
    } catch {
      return;
    }
  }

  /** A Task run's transcript as kept under `folder`'s `.widecode/tasks/<session>/<call>.jsonl` ("" for none). */
  taskTranscript(folder: string, session: string, call: string): string {
    return readTextOr(this.taskPath(folder, session, call), "");
  }

  /** Keep a Task run's transcript under the project; false when it cannot be written. */
  saveTaskTranscript(folder: string, session: string, call: string, text: string): boolean {
    const path = this.taskPath(folder, session, call);
    try {
      mkdirSync(join(folder, ".widecode", "tasks", this.taskPart(session)), { recursive: true });
      writeAtomic(path, text);
      return true;
    } catch {
      return false;
    }
  }

  private taskPart(id: string): string {
    return id.replace(/[^A-Za-z0-9_.-]/g, "_");
  }

  private taskPath(folder: string, session: string, call: string): string {
    return join(folder, ".widecode", "tasks", this.taskPart(session), this.taskPart(call) + ".jsonl");
  }

  limits(agent = "claude"): Limits {
    return this.limitsStore.limits(agent);
  }

  saveLimits(l: Limits, agent = "claude"): void {
    this.limitsStore.saveLimits(l, agent);
  }
}
