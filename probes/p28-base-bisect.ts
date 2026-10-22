// P28: which TNode/TElement member makes a subclass's Emitter<string> field lose `emit` natively?
import { Emitter } from "../packages/signals/src/emitter.ts";
import { Disposable, type PropValue } from "../packages/tdom/src/node.ts";
import { Handler, HandlerEntry, type UIEvent } from "../packages/tdom/src/events.ts";
import { DEFAULT_STYLE, Style } from "../packages/tdom/src/style.ts";
import { frames } from "../packages/tdom/src/scheduler.ts";

// Base1: TNode's data fields
abstract class Base1 {
  readonly kind: string;
  parent: Base1 | null = null;
  x = 0; y = 0; w = 0; h = 0; version = 0;
  constructor(kind: string) { this.kind = kind; }
}
class Leaf1 extends Base1 { readonly ev = new Emitter<string>(); constructor() { super("l1"); } }

// Base2: + TNode methods (ancestor walk with instanceof on a later class, invalidate via frames)
abstract class Base2 extends Base1 {
  isConnected(): boolean { let n: Base1 | null = this; while (n !== null) { if (n instanceof Root2) return true; n = n.parent; } return false; }
  invalidate(): void { let n: Base1 | null = this; while (n !== null) { n.version++; n = n.parent; } frames.request(); }
  dispose(): void { this.parent = null; }
}
class Root2 extends Base2 { constructor() { super("root"); } }
class Leaf2 extends Base2 { readonly ev = new Emitter<string>(); constructor() { super("l2"); } }

// Base3: + TElement data fields
abstract class Base3 extends Base2 {
  readonly tag: string;
  readonly children: Base1[] = [];
  style: Style = DEFAULT_STYLE;
  hidden = false;
  rootPart: Disposable | null = null;
  readonly handlers: HandlerEntry[] = [];
  constructor(kind: string, tag: string) { super(kind); this.tag = tag; }
}
class Leaf3 extends Base3 { readonly ev = new Emitter<string>(); constructor() { super("l3", "l3"); } }

// Base4: + abstract methods + tree ops
abstract class Base4 extends Base3 {
  abstract setProp(name: string, v: PropValue): void;
  abstract propsSummary(): string[];
  append(node: Base1): void { this.children.push(node); node.parent = this; this.invalidate(); }
  remove(node: Base1): void { const i = this.children.indexOf(node); if (i >= 0) { this.children.splice(i, 1); node.parent = null; } }
  override dispose(): void { this.children.length = 0; super.dispose(); }
}
class Leaf4 extends Base4 {
  readonly ev = new Emitter<string>();
  constructor() { super("l4", "l4"); }
  setProp(_n: string, _v: PropValue): void {}
  propsSummary(): string[] { return []; }
}

// Base5: + handler methods
abstract class Base5 extends Base4 {
  addHandler(name: string, h: Handler): void { this.handlers.push(new HandlerEntry(name, h)); }
  handle(e: UIEvent): boolean { for (const en of this.handlers.slice()) { if (en.name !== e.type) continue; en.handler.fn(e); if (e.consumed) return true; } return false; }
}
class Leaf5 extends Base5 {
  readonly ev = new Emitter<string>();
  constructor() { super("l5", "l5"); }
  setProp(_n: string, _v: PropValue): void {}
  propsSummary(): string[] { return []; }
}

function tryEmit(name: string, em: Emitter<string>): void {
  try { const got: string[] = []; em.listen((v) => got.push(v)); em.emit("ok"); console.log(name + ": " + got.join(",")); }
  catch (e) { console.log(name + ": threw " + (e instanceof Error ? e.message : String(e))); }
}
tryEmit("Leaf1", new Leaf1().ev);
tryEmit("Leaf2", new Leaf2().ev);
tryEmit("Leaf3", new Leaf3().ev);
tryEmit("Leaf4", new Leaf4().ev);
tryEmit("Leaf5", new Leaf5().ev);
