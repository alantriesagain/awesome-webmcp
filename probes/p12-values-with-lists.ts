// P12: a (Item | Item[])[] array whose elements include arrays, and a rest parameter of that type —
// the shape of TemplateResult.values when a template holds `${items.map(...)}`.
class Tpl {
  id: number;
  constructor(id: number) {
    this.id = id;
  }
}
class Live {
  fn: () => Value;
  constructor(fn: () => Value) {
    this.fn = fn;
  }
}
type Item = string | number | null | Tpl | Live;
type Value = Item | Item[];
class Result {
  strings: TemplateStringsArray;
  values: Value[];
  constructor(strings: TemplateStringsArray, values: Value[]) {
    this.strings = strings;
    this.values = values;
  }
}
function html(strings: TemplateStringsArray, ...values: Value[]): Result {
  return new Result(strings, values);
}
function showItem(v: Item): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number") return "n" + String(v);
  if (v instanceof Tpl) return "tpl#" + v.id;
  return "live(" + show(v.fn()) + ")";
}
function show(v: Value): string {
  if (Array.isArray(v)) return "[" + v.map((x) => showItem(x)).join(",") + "]";
  return showItem(v);
}
const ids = [1, 2, 3];
const r = html`<box>${"title"}${ids.map((i) => new Tpl(i))}${new Live(() => ids.map((i) => String(i)))}${7}${null}</box>`;
console.log(r.strings.length, r.values.length, r.values.map((v) => show(v)).join(" | "));
const direct: Value[] = ["a", [new Tpl(9), "b"], new Tpl(10), []];
console.log(direct.map((v) => show(v)).join(" | "));
for (const v of r.values) if (Array.isArray(v)) console.log("list of", v.length);
