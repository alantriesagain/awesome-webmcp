// P11: isolate the recursive-union crash from P1/P9 (nested array literal inside a union-typed array).
class Tpl {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}
type V = string | Tpl | V[];
function show(v: V): string {
  if (typeof v === "string") return v;
  if (v instanceof Tpl) return "#" + String(v.id);
  return "[" + v.map((x) => show(x)).join(",") + "]";
}
const flat: V[] = ["a", new Tpl(1)];
console.log("flat:", show(flat));
const inner: V[] = ["b", new Tpl(2)];
const built: V[] = ["a"];
built.push(inner);
console.log("built:", show(built));
const literal: V = ["a", ["b", new Tpl(3)]];
console.log("literal:", show(literal));
