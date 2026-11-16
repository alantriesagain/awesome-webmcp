// What the user keeps, for the real app: the store (~/.widecode, or $WIDECODE_HOME; none with
// --ephemeral, so tests and live checks leave nothing behind), an earlier ~/.ctui moved over once,
// and config.json as read. The plugins' own sections are written into a new config.json once the
// app knows its plugins (`seed`). A test's run has none of it. Each start reads them anew.
import { homedir } from "node:os";
import { join } from "node:path";
import { Controller } from "@lightstart/light/controller/class.ts";
import app from "../app.ts";
import { Config, PluginDefault, Store } from "../services/store.ts";
import log from "./log.ts";
import run from "./run.ts";

/** One start's settings. */
export class Settings {
  store: Store | null = null;
  config: Config | null = null;
  /** Why an earlier ~/.ctui was not moved, or what was moved ("" for neither). */
  migrated = "";
}

export class SettingsController extends Controller {
  /** This start's. */
  current = new Settings();

  constructor() {
    super("settings");
  }

  override connected(): Promise<void> | null {
    const s = new Settings();
    this.current = s;
    if (!run.current.real) return null;
    const store = app.args.flag("ephemeral") ? null : new Store(Store.defaultRoot());
    s.store = store;
    // An earlier version kept its data in ~/.ctui: moved over once.
    s.migrated = store !== null && (process.env["WIDECODE_HOME"] ?? "").length === 0 ? store.migrateFrom(join(homedir(), ".ctui")) : "";
    s.config = store !== null ? store.readConfig() : null;
    log.useStore(store, s.config);
    return null;
  }

  /** A first run's config.json, written with each plugin's section (`defaults`) once the plugins are known. */
  seed(defaults: PluginDefault[]): void {
    const s = this.current;
    if (s.store !== null && s.config !== null) s.store.seedConfig(s.config, defaults);
  }
}

export default new SettingsController();
