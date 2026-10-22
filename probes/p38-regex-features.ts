// The code view's tokenizers (apps/widecode/src/highlight) match at a position with sticky regexes
// (`y`), use Unicode property classes (`\p{L}` with `u`), lookahead and case-insensitive flags.
// Prints the same under node and natively.
const word = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const text = "  café_1 = naïve;";
word.lastIndex = 2;
const m = word.exec(text);
console.log("sticky unicode word: " + (m !== null ? m[0] + "@" + String(m.index) : "none"));
word.lastIndex = 1;
console.log("sticky refuses a later match: " + String(word.exec(text) === null));
const open = /<\/?(?=[a-zA-Z])/y;
open.lastIndex = 0;
const o = open.exec("</div>");
console.log("lookahead: " + (o !== null ? o[0] : "none"));
const doctype = /<!doctype[^>]*>?/iy;
doctype.lastIndex = 0;
console.log("case-insensitive: " + String(doctype.exec("<!DOCTYPE html>") !== null));
const ident = /-?[_a-zA-Z -￿][\w -￿-]*/y;
ident.lastIndex = 0;
const i = ident.exec("--brand-é: 1");
console.log("css ident: " + (i !== null ? i[0] : "none"));
const fn = /(-?[\w-]+)\(/y;
fn.lastIndex = 0;
const f = fn.exec("url(x)");
console.log("group: " + (f !== null ? f[1] : "none"));
const num = /(?:0[xX][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y;
num.lastIndex = 4;
const n = num.exec("x = 1_000n");
console.log("number: " + (n !== null ? n[0] : "none"));
const lazy = /.*?\*\//y;
lazy.lastIndex = 3;
const c = lazy.exec("/* a */ b");
console.log("lazy: " + (c !== null ? c[0] : "none"));
