import { Emitter } from "../../packages/signals/src/emitter.ts";
import { Handler, HandlerEntry } from "../../packages/tdom/src/events.ts";
import { poke } from "./ops.ts";
export abstract class Base {
  readonly kind: string;
  readonly handlers: HandlerEntry[] = [];
  parent: Base | null = null;
  constructor(kind: string) { this.kind = kind; }
  abstract describe(): string;
  addHandler(name: string, h: Handler): void { this.handlers.push(new HandlerEntry(name, h)); }
}
export class Leaf extends Base {
  lines: string[] = [""];
  row = 0;
  col = 0;
  placeholder = "";
  readonly changed = new Emitter<string>();
  readonly submitted = new Emitter<string>();
  constructor() { super("leaf"); }
  describe(): string { return this.lines.join("|"); }
  value(): string { return this.lines.join("\n"); }
  clear(): void { this.lines = [""]; }
  go(): void { poke(this); }
}
