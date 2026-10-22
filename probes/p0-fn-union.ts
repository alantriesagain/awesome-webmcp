// P0: does a union that mixes function members with data members compile statically?
// If this fails, html`` keeps boxed thunks/handlers (Live/Handler); if it passes, raw arrows become sugar.
class A {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}
class B {
  s = "b";
}
type V = string | A | V[] | (() => V) | ((e: B) => void);

function show(v: V): string {
  if (typeof v === "string") return "s:" + v;
  if (typeof v === "function") return "fn:" + v.length;
  if (Array.isArray(v)) return "[" + v.map((x) => show(x)).join(",") + "]";
  return "A:" + v.n;
}

const vs: V[] = ["x", new A(1), () => "y", (e: B) => { void e; }, ["z", new A(2), () => "q"]];
console.log(vs.map((v) => show(v)).join(" | "));

const thunk: V = () => "called";
if (typeof thunk === "function" && thunk.length === 0) {
  const r = (thunk as () => V)();
  console.log("call:", show(r));
}
