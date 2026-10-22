// P8: runtime pieces the renderer needs: Intl.Segmenter graphemes, code points, typed arrays,
// setImmediate/queueMicrotask/setTimeout ordering, String.fromCodePoint, padStart/repeat.
const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function graphemes(s: string): string[] {
  const out: string[] = [];
  for (const g of seg.segment(s)) out.push(g.segment);
  return out;
}
const samples = ["abc", "héllo", "😀x", "👨‍👩‍👧", "é", "日本"];
const parts: string[] = [];
for (const s of samples) {
  const gs = graphemes(s);
  parts.push(s + "=" + String(gs.length) + "/" + String(s.length) + "/" + String(s.codePointAt(0) ?? -1));
}
console.log(parts.join(" "));

const glyph = new Uint32Array(8);
const fg = new Int32Array(8);
glyph[3] = 0x1f600;
fg[3] = -1;
let nz = 0;
for (let i = 0; i < glyph.length; i++) if (glyph[i] !== 0) nz++;
console.log("typed:", nz, String.fromCodePoint(glyph[3]), fg[3], "x".repeat(3) + "|" + "7".padStart(3, "0"));

const order: string[] = [];
setTimeout(() => {
  order.push("timeout");
  console.log("order:", order.join(","));
}, 5);
setImmediate(() => order.push("immediate"));
queueMicrotask(() => order.push("micro"));
Promise.resolve().then(() => order.push("promise"));
order.push("sync");
