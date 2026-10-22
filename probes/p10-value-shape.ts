// P10: the proposed html`` value model — a NON-recursive union (lists of items, no nested lists),
// classes with fields typed as the union (Keyed.v, Live.fn returns it), and instanceof commit.
class Tpl {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}
class Keyed {
  k: string;
  v: Value;
  constructor(k: string, v: Value) {
    this.k = k;
    this.v = v;
  }
}
class Live {
  fn: () => Value;
  constructor(fn: () => Value) {
    this.fn = fn;
  }
}
type Item = string | number | boolean | null | undefined | Tpl | Keyed | Live;
type Value = Item | Item[];

function commitItem(v: Item): string {
  if (v === null) return "null";
  if (v === undefined) return "undef";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return "n" + String(v);
  if (typeof v === "boolean") return v ? "T" : "F";
  if (v instanceof Tpl) return "tpl#" + v.id;
  if (v instanceof Keyed) return "key(" + v.k + "," + commit(v.v) + ")";
  return "live(" + commit(v.fn()) + ")";
}
function commit(v: Value): string {
  if (Array.isArray(v)) return "[" + v.map((x) => commitItem(x)).join(",") + "]";
  return commitItem(v);
}
const n = 5;
const items: Value = [new Tpl(1), "x", new Keyed("k", [new Tpl(2), new Live(() => n * 2)]), null, true, 3];
console.log(commit(items));
const single: Value = new Live(() => [new Keyed("a", "b"), undefined]);
console.log(commit(single));
const fromMap: Value = [1, 2, 3].map((i) => new Keyed(String(i), new Tpl(i)));
console.log(commit(fromMap));
