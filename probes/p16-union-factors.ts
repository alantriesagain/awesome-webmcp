// P16: which factor breaks instanceof dispatch over the Value union natively?
import { Handler, Mountable, TBox, onKey } from "../packages/tdom/src/index.ts";
import { Keyed, TemplateResult, html, key } from "../packages/html/src/index.ts";

class A { a = 1; }
class B { b = 2; }
class Base { base = 3; }
class Sub extends Base { sub = 4; }
class Boxed { fn: () => string; constructor(fn: () => string) { this.fn = fn; } }
class LocalHandler { expects: string; fn: (s: string) => void; constructor(e: string, fn: (s: string) => void) { this.expects = e; this.fn = fn; } }

// U1: same-file classes + array arm (P10 shape)
type I1 = string | A | B;
type V1 = I1 | I1[];
function k1(v: V1): string { if (typeof v === "string") return "s"; if (v instanceof A) return "A"; if (v instanceof B) return "B"; return "arr" + String(v.length); }
console.log("U1 same-file:", ([new A(), new B(), "x", [new A(), "y"]] as V1[]).map(k1).join(","));

// U2: imported classes + array arm
type I2 = string | TemplateResult | Keyed;
type V2 = I2 | I2[];
function k2(v: V2): string { if (typeof v === "string") return "s"; if (v instanceof TemplateResult) return "T"; if (v instanceof Keyed) return "K"; return "arr" + String(v.length); }
console.log("U2 imported:", ([html`<text>${"x"}</text>`, key("k", "v"), "x", [key("a", "b")]] as V2[]).map(k2).join(","));

// U3: same-file base class with a subclass instance in the union
type I3 = string | Base | A;
type V3 = I3 | I3[];
function k3(v: V3): string { if (typeof v === "string") return "s"; if (v instanceof Base) return "Base"; if (v instanceof A) return "A"; return "arr" + String(v.length); }
console.log("U3 subclass:", ([new Sub(), new Base(), new A(), "x", [new Sub()]] as V3[]).map(k3).join(","));

// U4: imported Mountable (subclassed here) in the union
class W extends Mountable { constructor() { super(new TBox()); } }
type I4 = string | Mountable | A;
type V4 = I4 | I4[];
function k4(v: V4): string { if (typeof v === "string") return "s"; if (v instanceof Mountable) return "M:" + v.el.tag; if (v instanceof A) return "A"; return "arr" + String(v.length); }
console.log("U4 mountable:", ([new W(), new A(), "x", [new W()]] as V4[]).map(k4).join(","));

// U5: class holding a function field (Boxed / Handler) in the union
type I5 = string | Boxed | A;
type V5 = I5 | I5[];
function k5(v: V5): string { if (typeof v === "string") return "s"; if (v instanceof Boxed) return "Boxed:" + v.fn(); if (v instanceof A) return "A"; return "arr" + String(v.length); }
console.log("U5 fn-field class:", ([new Boxed(() => "f"), new A(), "x", [new Boxed(() => "g")]] as V5[]).map(k5).join(","));

// U6: imported Handler (function field, built by a factory) in the union
type I6 = string | Handler | A;
type V6 = I6 | I6[];
function k6(v: V6): string { if (typeof v === "string") return "s"; if (v instanceof Handler) return "H:" + v.expects; if (v instanceof A) return "A"; return "arr" + String(v.length); }
console.log("U6 handler:", ([onKey((_e) => {}), new A(), "x", [new A()]] as V6[]).map(k6).join(","));

// U7: local handler-like class with two function-ish fields
type I7 = string | LocalHandler | A;
type V7 = I7 | I7[];
function k7(v: V7): string { if (typeof v === "string") return "s"; if (v instanceof LocalHandler) return "LH:" + v.expects; if (v instanceof A) return "A"; return "arr" + String(v.length); }
console.log("U7 local handler:", ([new LocalHandler("key", (_s) => {}), new A(), "x"] as V7[]).map(k7).join(","));

// U8: many arms (10) of same-file classes
class C1 {c=1} class C2 {c=2} class C3 {c=3} class C4 {c=4} class C5 {c=5} class C6 {c=6}
type I8 = string | number | boolean | null | undefined | C1 | C2 | C3 | C4 | C5 | C6;
type V8 = I8 | I8[];
function k8(v: V8): string { if (v === null || v === undefined) return "n"; if (typeof v === "string") return "s"; if (typeof v === "number" || typeof v === "boolean") return "p"; if (v instanceof C1) return "1"; if (v instanceof C2) return "2"; if (v instanceof C3) return "3"; if (v instanceof C4) return "4"; if (v instanceof C5) return "5"; if (v instanceof C6) return "6"; return "arr" + String(v.length); }
console.log("U8 many arms:", ([new C1(), new C3(), new C6(), "x", 1, null, [new C2(), new C5()]] as V8[]).map(k8).join(","));
