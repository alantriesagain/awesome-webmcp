// P1: recursive value union without functions (the fallback shape for html`` values).
class Tpl {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}
class Keyed {
  k: string;
  v: V;
  constructor(k: string, v: V) {
    this.k = k;
    this.v = v;
  }
}
type V = string | number | boolean | null | undefined | Tpl | Keyed | V[];

function show(v: V): string {
  if (v === null) return "null";
  if (v === undefined) return "undef";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return "n" + String(v);
  if (typeof v === "boolean") return v ? "T" : "F";
  if (v instanceof Tpl) return "tpl#" + v.id;
  if (v instanceof Keyed) return "key(" + v.k + "," + show(v.v) + ")";
  return "[" + v.map((x) => show(x)).join(",") + "]";
}

const tree: V = ["a", 1, true, null, undefined, new Tpl(7), new Keyed("k1", ["nested", new Tpl(8), [new Keyed("k2", 2)]])];
console.log(show(tree));

// mutation + identity through the union
const t = new Tpl(9);
const arr: V[] = [t];
const first = arr[0];
console.log("identity:", first === t, first instanceof Tpl ? first.id : -1);
