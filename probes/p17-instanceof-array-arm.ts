// P17: instanceof on a union that has an array arm, three ways.
class A { a = 1; }
class B { b = 2; }
class C { c = 3; }
// C is never tested below: scriptc refuses a statically-decided instanceof (an exhausted union).
type Item = string | A | B | C;
type Value = Item | Item[];

// (1) instanceof directly on the union
function direct(v: Value): string {
  if (typeof v === "string") return "s";
  if (v instanceof A) return "A";
  if (v instanceof B) return "B";
  return "arr";
}
// (2) Array.isArray first, then instanceof in the same function (TS narrows to Item)
function narrowedInline(v: Value): string {
  if (Array.isArray(v)) return "arr";
  if (typeof v === "string") return "s";
  if (v instanceof A) return "A";
  if (v instanceof B) return "B";
  return "?";
}
// (3) Array.isArray first, then a function taking Item
function item(v: Item): string {
  if (typeof v === "string") return "s";
  if (v instanceof A) return "A";
  if (v instanceof B) return "B";
  return "?";
}
function narrowedCall(v: Value): string {
  if (Array.isArray(v)) return "arr";
  return item(v);
}
const vs: Value[] = [new A(), new B(), "x", [new A()]];
console.log("direct:", vs.map(direct).join(","));
console.log("inline:", vs.map(narrowedInline).join(","));
console.log("call:  ", vs.map(narrowedCall).join(","));
// (4) a ternary with instanceof after isArray
const ts: Value[] = [new A(), [new B()]];
console.log("ternary:", ts.map((t) => (Array.isArray(t) ? "arr" : t instanceof A ? "A" : "other")).join(","));
