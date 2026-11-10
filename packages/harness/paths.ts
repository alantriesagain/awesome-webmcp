// Where the harness keeps its own files under the store (`~/.widecode/harness/`): its logs, its
// sessions by folder, its skills and context file, and the keys file beside the store's config.
import { join } from "node:path";

export class HarnessPaths {
  readonly storeRoot: string;
  /** The user's home, whose `.agents/skills` and `.claude/skills` hold the user's skills ("" for none). */
  userHome = "";

  constructor(storeRoot: string) {
    this.storeRoot = storeRoot;
  }

  root(): string {
    return join(this.storeRoot, "harness");
  }

  /** The user's extensions, beside the app's plugins (`~/.widecode/extensions`). */
  extensionsDir(): string {
    return join(this.storeRoot, "extensions");
  }

  logsDir(): string {
    return join(this.root(), "logs");
  }

  /** The sessions of `folder`: its path with every `/` made `-`, as Claude Code keys its projects. */
  sessionsDir(folder: string): string {
    return join(this.root(), "sessions", folder.replace(/[^A-Za-z0-9]/g, "-"));
  }

  configPath(): string {
    return join(this.storeRoot, "config.json");
  }

  authPath(): string {
    return join(this.storeRoot, "auth.json");
  }
}
