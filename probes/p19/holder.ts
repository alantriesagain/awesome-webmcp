import { Emitter } from "../../packages/signals/src/emitter.ts";
export class Holder {
  readonly changed = new Emitter<string>();
  n = 0;
  value(): string { return "v" + String(this.n); }
}
