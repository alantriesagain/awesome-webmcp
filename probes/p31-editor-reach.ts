// P31: does merely making editor.ts code reachable break Emitter<string>.emit elsewhere?
import { Emitter } from "../packages/signals/src/emitter.ts";
import { TElement, TInput, type PropValue } from "../packages/tdom/src/node.ts";
import { clearInput } from "../packages/tdom/src/editor.ts";

class WithGeneric extends TElement {
  readonly ev = new Emitter<string>();
  constructor() { super("x", "x"); }
  setProp(_n: string, _v: PropValue): void {}
  propsSummary(): string[] { return []; }
}
function report(name: string, fn: () => string): void {
  try { console.log(name + ": " + fn()); } catch (e) { console.log(name + ": threw " + (e instanceof Error ? e.message : String(e))); }
}
report("generic field before", () => { const o = new WithGeneric(); const got: string[] = []; o.ev.listen((v) => got.push(v)); o.ev.emit("ok"); return got.join(","); });
report("tinput emit", () => { const i = new TInput(); const got: string[] = []; i.changed.listen((v) => got.push(v)); i.changed.emit("direct"); return got.join(","); });
report("clearInput", () => { const i = new TInput(); clearInput(i); return JSON.stringify(i.lines); });
