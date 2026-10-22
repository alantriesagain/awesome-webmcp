// P23: which member of TInput breaks `input.changed.emit` natively? Subclasses of the real TElement.
import { Emitter } from "../packages/signals/src/emitter.ts";
import { KeyEvent, TElement, type PropValue } from "../packages/tdom/src/index.ts";
import { clearInput, editorHandleKey, setValue } from "../packages/tdom/src/editor.ts";

class A extends TElement {
  lines: string[] = [""];
  readonly changed = new Emitter<string>();
  constructor() { super("input", "input"); }
  setProp(_n: string, _v: PropValue): void {}
  propsSummary(): string[] { return []; }
}
class B extends A {
  value(): string { return this.lines.join("\n"); }
  isEmpty(): boolean { return this.lines.length === 1 && this.lines[0].length === 0; }
}
class C extends TElement {
  lines: string[] = [""];
  row = 0;
  col = 0;
  readonly changed = new Emitter<string>();
  readonly submitted = new Emitter<string>();
  constructor() { super("input", "input"); }
  setProp(_n: string, _v: PropValue): void {}
  propsSummary(): string[] { return []; }
  value(): string { return this.lines.join("\n"); }
  handleKey(e: KeyEvent): boolean { return e.key === "x"; }
}
class D extends TElement {
  lines: string[] = [""];
  row = 0;
  col = 0;
  placeholder = "";
  minLines = 1;
  maxLines = 8;
  readonly changed = new Emitter<string>();
  readonly submitted = new Emitter<string>();
  constructor() { super("input", "input"); }
  setProp(_n: string, _v: PropValue): void {}
  propsSummary(): string[] { return []; }
  value(): string { return this.lines.join("\n"); }
  setValueX(t: string): void { setValue(this as unknown as never, t); }
  clearX(): void { clearInput(this as unknown as never); }
  handleKey(e: KeyEvent): boolean { return editorHandleKey(this as unknown as never, e); }
}
function tryEmit(name: string, em: Emitter<string>): void {
  try {
    const got: string[] = [];
    em.listen((v) => got.push(v));
    em.emit("ok");
    console.log(name + ": " + got.join(","));
  } catch (e) {
    console.log(name + ": threw " + (e instanceof Error ? e.message : String(e)));
  }
}
tryEmit("A", new A().changed);
tryEmit("B", new B().changed);
const c = new C();
tryEmit("C.changed", c.changed);
tryEmit("C.submitted", c.submitted);
const d = new D();
tryEmit("D.changed", d.changed);
tryEmit("D.submitted", d.submitted);
