// The keymaps: the one in use (emacs unless config.json's "keymap", /keymap or the onboarding says
// otherwise, kept in state.json), the ones plugins bring (/keymap lists them; a keymap plugin turns
// its layers on when the state names it), and the user's keys.json over the keymap, read by
// `onRead` and applied as the kernel's user layer. `changed` fires when the keymap in use changes.
import { errorMessage } from "@lightstart/lib/json.ts";
import { Controller } from "@lightstart/light/controller/class.ts";
import { Hook } from "@lightstart/lib/hook.ts";
import { Kernel } from "@lightstart/kernel/kernel.ts";
import { keyEntriesOf } from "@lightstart/kernel/keys.ts";

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
  keymap = "emacs";
  /** The keymaps plugins brought, for /keymap's list. */
  keymaps: KeymapDef[] = [];
  /** Answers the user's keys.json text ("" for none); null without a store. */
  onRead: (() => string) | null = null;
  /** The keymap in use changed. */
  readonly changed = new Hook();

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

  /** Use keymap `name` from now on, kept for the next run. */
  set(name: string): void {
    this.keymap = name;
    this.kernel.settings.setState("keymap", name);
    this.changed.fire();
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
