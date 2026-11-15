// The commands the core adds: the shell's help, welcome, keymap and columns, the plugin reload,
// the log's path, trust, and the agent to talk to. A plugin adds its own through the kernel; this
// is the one place the app's own are added, not the views that draw them.
import { Command, Suggestion } from "@light/kernel/commands.ts";
import { logPath } from "@light/lib/log.ts";
import type { Widecode } from "./compose.ts";
import type { Store } from "./services/store.ts";
import { welcome } from "./views/onboarding.ts";

/** The commands every composed widecode has, store or not. */
export const registerShellCommands = (w: Widecode): void => {
  const h = w.host;
  const k = h.kernel;
  k.commands.add(new Command("/help", "", "this list", "shell", (_arg: string) => w.shell.help()));
  k.commands.add(new Command("/welcome", "", "the welcome: the columns, the keys and commands to start with", "shell", (_arg: string) => welcome(h)));
  const keymap = new Command("/keymap", "[name]", "the keymap in use: default, or one a plugin brings (emacs, vi); kept for the next run", "shell", (arg: string) => w.shell.keymapCommand(arg.trim()));
  keymap.onComplete = (arg: string): Suggestion[] => h.keys.names().filter((n) => n.startsWith(arg.trim())).map((n) => new Suggestion(n, n, n === h.keys.keymap ? "now" : ""));
  k.commands.add(keymap);
  k.commands.add(new Command("/columns", "[reset]", "the columns' widths; reset forgets the widths borders were dragged to", "shell", (arg: string) => w.shell.columnsCommand(arg)));
  k.commands.add(new Command("/reload", "", "evaluate every JS plugin again (the agent restarts and resumes the session)", "plugins", (_arg: string) => w.js.reload()));
  k.commands.add(
    new Command("/log", "", "where this run's log goes (config.json's \"log\" turns it off or moves it)", "shell", (_arg: string) => {
      const p = logPath();
      h.screen.tell(p.length > 0 ? "log: " + p : "the log is off (config.json's \"log\", or --log <path>)");
    }),
  );
};

/** The commands that need the user's store and the folder's trust. */
export const registerStoreCommands = (w: Widecode, store: Store | null, trust: () => void): void => {
  if (store === null) return;
  const h = w.host;
  const k = h.kernel;
  k.commands.add(new Command("/trust", "", "trust this folder: the agent works here and its own harness (.widecode: plugins, prompt, config) runs, now and on every launch", "plugins", (_arg: string) => trust()));
  k.commands.add(
    new Command("/agent", "<id>", "the agent to talk to (claude, or one a plugin brings), kept in config.json", "plugins", (arg: string) => {
      const id = arg.trim();
      if (id.length === 0) {
        h.screen.tell("agent " + h.session.agentId.peek() + " (" + h.session.agents.map((a) => a.id()).join(", ") + "); /agent <id> switches");
        return;
      }
      const error = h.session.useAgent(id);
      if (error.length > 0) {
        h.screen.tell(error);
        return;
      }
      const written = store.setConfigValue("agent", id);
      h.screen.tell(written.length > 0 ? written : "agent " + id + ", kept in config.json");
    }),
  );
};
