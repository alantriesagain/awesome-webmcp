// P4: Map<TemplateStringsArray, Class> cache keyed by per-call-site strings identity (no .raw).
class Tpl {
  parts: string[];
  uses = 0;
  constructor(strings: TemplateStringsArray) {
    this.parts = Array.from(strings);
  }
}
class Result {
  tpl: Tpl;
  values: number[];
  constructor(tpl: Tpl, values: number[]) {
    this.tpl = tpl;
    this.values = values;
  }
}
const cache = new Map<TemplateStringsArray, Tpl>();
function html(strings: TemplateStringsArray, ...values: number[]): Result {
  let t = cache.get(strings);
  if (t === undefined) {
    t = new Tpl(strings);
    cache.set(strings, t);
  }
  t.uses++;
  return new Result(t, values);
}
function renderA(n: number): Result {
  return html`<box n=${n}>${n * 2}</box>`;
}
function renderB(s: number): Result {
  return html`<text>${s}</text>`;
}
const r1 = renderA(1);
const r2 = renderA(2);
const r3 = renderB(3);
console.log("sites:", cache.size, "| same tpl:", r1.tpl === r2.tpl, "| uses:", r1.tpl.uses, r3.tpl.uses, "| parts:", r1.tpl.parts.join("~"), "| values:", r2.values.join(","));
