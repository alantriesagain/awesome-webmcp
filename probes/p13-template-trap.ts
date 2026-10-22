// P13: bisect the silent native exit seen in test/parts.test.ts section 2 (template commit).
import { TBox, TRoot, dumpTree, textOf } from "../packages/tdom/src/index.ts";
import { html, render, templateCacheSize, TemplateResult, type Value } from "../packages/html/src/index.ts";

const root = new TRoot();
console.log("a: cache", templateCacheSize());
const t1: Value = html`<text>${"x"}</text>`;
console.log("b: built simple template result");
render(t1, root, null);
console.log("c: rendered simple ->", JSON.stringify(textOf(root)));
console.log("d:", dumpTree(root, false).split("\n").join(" / "));
const root2 = new TRoot();
const view = (name: string, n: number): TemplateResult => html`<box border title=${name}><text>Count: ${n}</text></box>`;
console.log("e: view fn ready");
const r = view("a", 1);
console.log("f: result values", r.values.length);
render(r, root2, null);
console.log("g: rendered nested");
const box = root2.children[1];
console.log("h: child kind", box.kind, box instanceof TBox ? (box as TBox).title : "?");
console.log("i:", dumpTree(root2, false).split("\n").join(" / "));
render(view("b", 2), root2, null);
console.log("j:", dumpTree(root2, false).split("\n").join(" / "));
