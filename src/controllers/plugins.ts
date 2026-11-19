// This start's JS plugins (src/plugins.ts: the runtime, the built-in, user and project plugins, their
// defaults and start), a new one each start over the start's host and run.
import { Controller } from "@lightstart/light/controller/class.ts";
import { Plugins } from "../plugins.ts";
import host from "./host.ts";
import run from "./run.ts";
import settings from "./settings.ts";

export class PluginsHolder extends Controller {
  /** This start's; set once the start made it. */
  current!: Plugins;

  constructor() {
    super("plugins");
  }

  override connected(): Promise<void> | null {
    const plugins = new Plugins(host.current);
    plugins.js.builtinDir = run.current.builtinDir;
    this.current = plugins;
    return null;
  }

  /** The plugin sections a first run's config.json gets, once the start's plugins are known. */
  seed(): void {
    settings.seed(this.current.defaults());
  }

  override disconnected(): Promise<void> | null {
    this.current.close();
    return null;
  }
}

export default new PluginsHolder();
