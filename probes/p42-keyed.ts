// P42: a generic class with methods and no function fields (three parallel arrays: keys, owners,
// items) beside light's template engine. The kernel's registries (commands, actions, key layers,
// segments) share this shape: a later item of a key replaces the earlier in its place, an owner's
// items go together. One Keyed<T> may hold them if its methods survive the link with the engine
// and dispatch on the items it holds.
import { Caret, Clip, DEFAULT_STYLE, Screen, TRoot, View, frames, html, layout, mount, paint } from "../light/native/index.ts";

class Keyed<T> {
  private keys: string[] = [];
  private owners: string[] = [];
  private items: T[] = [];

  /** Put `item` under `key` as `owner`'s: in the place of the earlier item of the key, else last. */
  put(key: string, owner: string, item: T): void {
    for (let i = 0; i < this.keys.length; i++)
      if (this.keys[i] === key) {
        this.owners[i] = owner;
        this.items[i] = item;
        return;
      }
    this.keys.push(key);
    this.owners.push(owner);
    this.items.push(item);
  }

  get(key: string): T | null {
    for (let i = 0; i < this.keys.length; i++) if (this.keys[i] === key) return this.items[i];
    return null;
  }

  removeOwner(owner: string): void {
    for (let i = this.keys.length - 1; i >= 0; i--)
      if (this.owners[i] === owner) {
        this.keys.splice(i, 1);
        this.owners.splice(i, 1);
        this.items.splice(i, 1);
      }
  }

  values(): T[] {
    return this.items.slice();
  }

  size(): number {
    return this.keys.length;
  }
}

class Cmd {
  readonly name: string;
  readonly help: string;

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
}

class Seg {
  readonly name: string;
  readonly width: number;

  constructor(name: string, width: number) {
    this.name = name;
    this.width = width;
  }

  draw(): string {
    return this.name + ":" + String(this.width);
  }
}

class Listing extends View {
  readonly commands: Keyed<Cmd>;

  constructor(commands: Keyed<Cmd>) {
    super();
    this.commands = commands;
  }

  override render(): unknown {
    return html`<div>${this.commands.values().map((c) => html`<div>${c.name + " " + c.help}</div>`)}</div>`;
  }
}

const commands = new Keyed<Cmd>();
commands.put("/open", "core", new Cmd("/open", "open a folder"));
commands.put("/trust", "core", new Cmd("/trust", "trust it"));
commands.put("/open", "plugin", new Cmd("/open", "open a folder, the plugin's"));
commands.put("/x", "plugin", new Cmd("/x", "x"));
const open = commands.get("/open");
console.log("size " + String(commands.size()) + " open " + (open === null ? "none" : open.help));
console.log("names " + commands.values().map((c) => c.name).join(","));

const segments = new Keyed<Seg>();
segments.put("clock", "status", new Seg("clock", 5));
segments.put("git", "git", new Seg("git", 8));
segments.put("clock", "status", new Seg("clock", 6));
console.log("segments " + segments.values().map((s) => s.draw()).join(" "));
segments.removeOwner("git");
console.log("without git " + segments.values().map((s) => s.draw()).join(" ") + " size " + String(segments.size()));

const W = 40;
const H = 4;
const root = new TRoot();
const listing = new Listing(commands);
mount(listing, root);
const screen = (): string[] => {
  for (let i = 0; i < 3; i++) {
    frames.flush();
    layout(root, W, H, DEFAULT_STYLE);
  }
  const s = new Screen(W, H);
  paint(root, s, new Clip(0, 0, W, H), DEFAULT_STYLE, new Caret(), null);
  return s.text().split("\n").map((l) => l.trimEnd());
};
for (const l of screen()) console.log("| " + l);
commands.removeOwner("plugin");
listing.$requestUpdate();
console.log("after removeOwner(plugin) size " + String(commands.size()) + " names " + commands.values().map((c) => c.name).join(","));
for (const l of screen()) console.log("| " + l);
