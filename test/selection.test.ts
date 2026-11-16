// ffi: @lightstart/plugins/native/ffi.json
// Selecting by dragging in a pane: the rows' text as a copy gives it (a prompt's prefix left out, a
// wrapped paragraph joined back, a word cut mid-way joined without a space), the selection drawn
// inverse on its cells; in the app, a drag in the code column copies the file's own text (no
// gutter, a line the pane cut taken whole), the status bar says how much, and a press without a
// drag still acts as a press; below the last line it presses nothing, and a drag from there
// selects up from the last line's end.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Widecode } from "../src/compose.ts";
import { Line, LineSource, Run } from "@lightstart/light/native/tui/lines.ts";
import { copyRows, DEFAULT_STYLE, frames, hitTest, layout, MouseEvent, mount, selectRuns, TElement, TRoot, unmount } from "@lightstart/light/native/tui";
import { wrap } from "@lightstart/tui/text.ts";
import { done, eq } from "@lightstart/test/assert.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";

class Rows extends LineSource {
  lines: Line[] = [];
  count(): number {
    return this.lines.length;
  }
  line(index: number, _width: number): Line {
    return this.lines[index];
  }
}

const rows = new Rows();
rows.lines = wrap([new Run("the quick brown fox jumps over the lazy dog", "")], 16, [new Run("› ", "")], [new Run("  ", "")], "");
eq("a paragraph wrapped under a prompt's prefix", rows.lines.map((l) => l.runs.map((r) => r.text).join("")).join("|"), "› the quick|  brown fox|  jumps over the|  lazy dog");
eq("copied whole: the prefix left out, the rows joined back", copyRows(rows, 0, 0, rows.count() - 1, -1, 16), "the quick brown fox jumps over the lazy dog");
eq("from the middle of a row to the middle of another", copyRows(rows, 0, 6, 1, 7, 16), "quick brown");
rows.lines = wrap([new Run("abcdefghijklmnopqrstuvwxyz", "")], 10, [], [], "");
eq("a word cut by the width joins without a space", copyRows(rows, 0, 0, rows.count() - 1, -1, 10), "abcdefghijklmnopqrstuvwxyz");
const l = new Line();
l.add("hello ", "");
l.add("world", "#61afef");
eq("the selection drawn inverse on its cells", selectRuns(l, 3, 8).map((r) => (r.inverse ? "[" + r.text + "]" : r.text)).join(""), "hel[lo ][wo]rld");

const decoded = (osc: string): string => Buffer.from(osc.slice("\x1b]52;c;".length, osc.length - 1), "base64").toString("utf8");

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-selection-"));
  const long = "export const config = { " + "name: 'x', ".repeat(30) + "};";
  writeFileSync(join(folder, "code.ts"), "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;\n" + long + "\n");
  writeFileSync(join(folder, "notes.md"), "# notes\n");
  const root = new TRoot();
  const W = 160;
  const H = 24;
  const w = await openWidecode({
    folder,
    load: true,
    before: (w: Widecode) => {
      w.shell.resize(W);
      mount(w.shell, root);
    },
  });
  const copied: string[] = [];
  w.host.screen.clipboard.mode = "osc52";
  w.host.screen.clipboard.onWrite = (text: string) => copied.push(decoded(text));
  await w.code.load("code.ts");
  const settle = (): void => {
    for (let i = 0; i < 3; i++) {
      frames.flush();
      layout(root, W, H, DEFAULT_STYLE);
    }
  };
  settle();
  /** A left drag from (x0, y0) to (x1, y1), its moves and release going to what was pressed. */
  const drag = (x0: number, y0: number, x1: number, y1: number): void => {
    const target = hitTest(root, x0, y0);
    if (!(target instanceof TElement)) return;
    target.dispatch(new MouseEvent("mousedown", x0, y0, 0, false, false, false));
    target.dispatch(new MouseEvent("mousemove", x1, y1, 0, false, false, false));
    target.dispatch(new MouseEvent("mouseup", x1, y1, 0, false, false, false));
    settle();
  };
  const view = w.code.pane.view;
  const x = view.box.x;
  const y = view.box.y;
  const gutter = 5;
  drag(x + gutter + 6, y, x + gutter + 4, y + 2);
  eq("a drag in the code column copies the file's text, no gutter", copied[copied.length - 1] ?? "", "alpha = 1;\nconst beta = 2;\nconst");
  eq("the status bar says how much", w.host.screen.message.peek(), "copied 3 lines");
  drag(x + gutter, y + 3, x + view.cols - 1, y + 3);
  eq("dragged to the edge, a line the pane cut is taken whole", copied[copied.length - 1] ?? "", long);
  const n = copied.length;
  w.host.screen.showPanel("files");
  settle();
  const tab = w.host.screen.findPanel("files");
  const tabView = tab !== null ? tab.view : null;
  if (tabView !== null) {
    // The Files tab: the folder's two files; a press (no drag) on notes.md opens it.
    const row = tabView.box.y + 1;
    drag(tabView.box.x + 4, row, tabView.box.x + 4, row);
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  eq("a press without a drag still acts as a press, copying nothing", w.code.path() + " " + String(copied.length - n), "notes.md 0");
  if (tabView !== null) drag(tabView.box.x + 4, tabView.box.y + tabView.rows - 1, tabView.box.x + 4, tabView.box.y + tabView.rows - 1);
  eq("a press below the last line: nothing pressed, nothing copied", w.code.path() + " " + String(copied.length - n), "notes.md 0");
  if (tabView !== null) drag(tabView.box.x + 6, tabView.box.y + tabView.rows - 1, tabView.box.x, tabView.box.y);
  const up = (copied[copied.length - 1] ?? "").split("\n").map((l) => l.trim());
  eq("a drag up from there selects to the end of the last line", up.join("|"), "code.ts|notes.md");
  unmount(w.shell);
  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
