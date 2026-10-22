// P15: instanceof dispatch over the exact html Value union (TemplateResult, Keyed, Live, Handler, Mountable, arrays).
import { Handler, Mountable, TBox, onKey } from "../packages/tdom/src/index.ts";
import { Keyed, Live, TemplateResult, html, key, live, type Item, type Value } from "../packages/html/src/index.ts";

class W extends Mountable {
  constructor() {
    super(new TBox());
  }
}
function kindOf(v: Value): string {
  if (v === null || v === undefined) return "nullish";
  if (typeof v === "string") return "string";
  if (typeof v === "number" || typeof v === "boolean") return "prim";
  if (v instanceof TemplateResult) return "template(" + String(v.values.length) + ")";
  if (v instanceof Keyed) return "keyed(" + v.k + ")";
  if (v instanceof Mountable) return "mount(" + v.el.tag + ")";
  if (v instanceof Handler) return "handler(" + v.expects + ")";
  if (v instanceof Live) return "live";
  return "items(" + String(v.length) + ")";
}
const items: Item[] = ["a", 1];
const all: Value[] = [html`<text>${"x"}</text>`, key("k", "v"), new W(), onKey((_e) => {}), live(() => "z"), items, null, undefined, "s", true];
console.log(all.map((v) => kindOf(v)).join(" "));
const single: Value = html`<text>${"x"}${"y"}</text>`;
console.log(kindOf(single));
