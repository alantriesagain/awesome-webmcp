import { Emitter } from "../../packages/signals/src/emitter.ts";
import { bumpOps } from "./ops.ts";
export abstract class Base {
  readonly kind: string;
  constructor(kind: string) { this.kind = kind; }
  abstract describe(): string;
}
export class Leaf extends Base {
  n = 0;
  readonly changed = new Emitter<string>();
  constructor() { super("leaf"); }
  describe(): string { return "leaf" + String(this.n); }
  bump(): void { bumpOps(this); }
}
