// The keymaps: the one in use (emacs unless config.json's "keymap", /keymap or the onboarding says
// otherwise, kept in state.json), the ones plugins bring (/keymap lists them; a keymap plugin turns
// its layers on when the state names it), and the user's keys.json over the keymap, read by
// `onRead` and applied as the kernel's user layer. `keymap` is the keymap in use, a signal.
import { errorMessage } from "@lightstart/lib/json.ts";
import { Controller } from "@lightstart/light/controller/class.ts";
import { signal } from "@lightstart/light/signals";
import { Kernel } from "@lightstart/kernel/kernel.ts";
import { keyEntriesOf } from "@lightstart/kernel/keys.ts";
import { Command, Suggestion } from "@lightstart/kernel/commands.ts";

/** A keymap a plugin brought, by the name /keymap takes. */
export class KeymapDef {
  readonly id: string;
  readonly name: string;
  readonly owner: string;

  constructor(id: string, name: string, owner: string) {
    this.id = id;
    this.name = name;
    this.owner = owner;
  }
}


export class KeymapController extends Controller {
  readonly kernel: Kernel;
  /** The keymap in use. */
  readonly keymap = signal("emacs");
  /** The keymaps plugins brought, for /keymap's list. */
  keymaps: KeymapDef[] = [];
  /** Answers the user's keys.json text ("" for none); null without a store. */
  onRead: (() => string) | null = null;
  /** Says what /keymap did in the status bar; the app sets it (the screen starts after the keymap). */
  tell: ((text: string) => void) | null = null;

  constructor(kernel: Kernel) {
    super("keymaps");
    this.kernel = kernel;
  }

  /** The keymaps there are: the default, then the plugins'. */
  names(): string[] {
    const out = ["default"];
    for (const k of this.keymaps) if (!out.includes(k.id)) out.push(k.id);
    return out;
  }

  /** The /keymap command, per start (the kernel is new each start); the shell adds it in its command order. */
  registerCommands(): void {
    const command = new Command("/keymap", "[name]", "the keymap in use: default, or one a plugin brings (emacs, vi); kept for the next run", "shell", (arg: string) => this.use(arg.trim()));
    command.onComplete = (arg: string): Suggestion[] => this.names().filter((n) => n.startsWith(arg.trim())).map((n) => new Suggestion(n, n, n === this.keymap.value ? "now" : ""));
    this.kernel.commands.add(command);
  }

  /** /keymap: the one in use and the ones there are; `/keymap <name>` switches, kept for the next run. */
  use(name: string): void {
    const names = this.names();
    const say = this.tell;
    if (name.length === 0) {
      if (say !== null) say("keymap " + this.keymap.value + " (" + names.join(", ") + "); /keymap <name> switches");
      return;
    }
    if (!names.includes(name)) {
      if (say !== null) say("no keymap named " + name + " (" + names.join(", ") + ")");
      return;
    }
    this.set(name);
    if (say !== null) say("keymap " + name);
  }

  /** Use keymap `name` from now on, kept for the next run. */
  set(name: string): void {
    this.keymap.value = name;
    this.kernel.settings.setState("keymap", name);
  }

  /** A keymap plugin `def.owner` brings; a later one of the id replaces the earlier. */
  add(def: KeymapDef): void {
    this.keymaps = this.keymaps.filter((k) => k.id !== def.id);
    this.keymaps.push(def);
  }

  /** Read the user's keys.json again and make it the kernel's user layer; what to tell when it is not valid ("" when it is). */
  applyUser(): string {
    const fn = this.onRead;
    const text = fn !== null ? fn() : "";
    if (text.trim().length === 0) {
      this.kernel.keys.setUser([]);
      return "";
    }
    let value: unknown = null;
    try {
      value = JSON.parse(text);
    } catch (err) {
      this.kernel.keys.setUser([]);
      return "keys.json is not valid JSON (" + (errorMessage(err, "error")) + "); the keys are the keymap's";
    }
    this.kernel.keys.setUser(keyEntriesOf(value));
    return "";
  }

  /** Drop the keymaps plugin `owner` brought. */
  removeOwner(owner: string): void {
    this.keymaps = this.keymaps.filter((k) => k.owner !== owner);
  }
}
