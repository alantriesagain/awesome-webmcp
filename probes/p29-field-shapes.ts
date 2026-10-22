// P29: on a subclass of the real TElement, which field shape survives natively?
import { Emitter } from "../packages/signals/src/emitter.ts";
import { TElement, type PropValue } from "../packages/tdom/src/node.ts";

class StringEmitter {
  private listeners: ((v: string) => void)[] = [];
  listen(fn: (v: string) => void): void { this.listeners.push(fn); }
  emit(v: string): void { for (const fn of this.listeners.slice()) fn(v); }
}
class WithGeneric extends TElement {
  readonly ev = new Emitter<string>();
  constructor() { super("x", "x"); }
  setProp(_n: string, _v: PropValue): void {}
  propsSummary(): string[] { return []; }
}
class WithPlain extends TElement {
  readonly ev = new StringEmitter();
  constructor() { super("x", "x"); }
  setProp(_n: string, _v: PropValue): void {}
  propsSummary(): string[] { return []; }
}
class WithArray extends TElement {
  readonly fns: ((v: string) => void)[] = [];
  constructor() { super("x", "x"); }
  setProp(_n: string, _v: PropValue): void {}
  propsSummary(): string[] { return []; }
  emit(v: string): void { for (const fn of this.fns.slice()) fn(v); }
}
class WithLateGeneric extends TElement {
  ev: Emitter<string> | null = null;
  constructor() { super("x", "x"); this.ev = new Emitter<string>(); }
  setProp(_n: string, _v: PropValue): void {}
  propsSummary(): string[] { return []; }
}
function report(name: string, fn: () => string): void {
  try { console.log(name + ": " + fn()); } catch (e) { console.log(name + ": threw " + (e instanceof Error ? e.message : String(e))); }
}
report("generic field", () => { const o = new WithGeneric(); const got: string[] = []; o.ev.listen((v) => got.push(v)); o.ev.emit("ok"); return got.join(","); });
report("plain class field", () => { const o = new WithPlain(); const got: string[] = []; o.ev.listen((v) => got.push(v)); o.ev.emit("ok"); return got.join(","); });
report("array field", () => { const o = new WithArray(); const got: string[] = []; o.fns.push((v) => got.push(v)); o.emit("ok"); return got.join(","); });
report("late generic", () => { const o = new WithLateGeneric(); const got: string[] = []; const ev = o.ev; if (ev === null) return "null"; ev.listen((v) => got.push(v)); ev.emit("ok"); return got.join(","); });
report("generic via local", () => { const o = new WithGeneric(); const ev = o.ev; const got: string[] = []; ev.listen((v) => got.push(v)); ev.emit("ok"); return got.join(","); });
report("generic size", () => { const o = new WithGeneric(); o.ev.listen((_v) => {}); return String(o.ev.size); });
