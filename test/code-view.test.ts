// The code column's source: the gutter, the text, and the one blank column it keeps before the
// scrollbar. A line wider than the box stops one cell short of its edge, wrapped or not, while an
// added or removed line's tint still fills the row.
import { ADDED, CodeFile, CodeLine, KEPT } from "../src/code/diff.ts";
import { CodeSource } from "../src/code/code-view.ts";
import { done, eqn, ok } from "@lightstart/test/assert.ts";

const LONG = "const value = [" + Array.from({ length: 30 }, (_v, i) => "item" + String(i)).join(", ") + "];";
const WIDTH = 40;

const file = new CodeFile();
file.path = "a.ts";
file.lines = [new CodeLine(KEPT, 1, 1, LONG), new CodeLine(ADDED, 0, 2, LONG)];

const source = new CodeSource();
source.setFile(file);

/** A row's runs as text, its trailing blanks trimmed. */
const rowText = (index: number, width: number): string => source.line(index, width).runs.map((r) => r.text).join("").replace(/\s+$/, "");

ok("the line is wider than the box", LONG.length > WIDTH);

source.wrap = false;
source.prepare(WIDTH);
const unwrapped = rowText(0, WIDTH);
eqn("unwrapped, the text stops one column before the box's edge", unwrapped.length, WIDTH - 1);
ok("the last character is not in the final column", unwrapped.length - 1 < WIDTH - 1);
const addedRow = source.line(1, WIDTH);
eqn("an added line is clipped the same way", rowText(1, WIDTH).length, WIDTH - 1);
ok("its tint still fills the row", addedRow.bg.length > 0);

source.wrap = true;
source.prepare(WIDTH);
ok("wrapping puts the line on several rows", source.count() > 1);
let widest = 0;
let tinted = true;
const addedFrom = source.rowOf(1);
for (let i = 0; i < source.count(); i++) {
  const row = source.line(i, WIDTH);
  const text = row.runs.map((r) => r.text).join("").replace(/\s+$/, "");
  widest = Math.max(widest, text.length);
  if (i >= addedFrom && row.bg.length === 0) tinted = false;
}
ok("wrapped rows never reach the final column", widest <= WIDTH - 1);
ok("and each row of an added line keeps its tint", tinted);

done();
