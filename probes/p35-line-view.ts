// The TUI's windowed line view renders only the rows that fit, each a `<p wrap="none">` with one
// `<span>` per styled run. What does a frame cost when every visible row changes (a scroll step):
// 200 rows x 10 runs, template-rendered, laid out and painted headlessly? Prints the painted
// first row (same under node and natively) and the frame times (stderr).
import { Caret, Clip, DEFAULT_STYLE, Screen, TRoot, View, frames, html, layout, mount, paint, signal } from "../apps/harness/src/light.ts";
import type { Signal } from "../apps/harness/src/light.ts";

class Run {
  text: string;
  fg: string;
  bold: boolean;
  constructor(text: string, fg: string, bold: boolean) {
    this.text = text;
    this.fg = fg;
    this.bold = bold;
  }
}

class Row {
  runs: Run[];
  bg: string;
  constructor(runs: Run[], bg: string) {
    this.runs = runs;
    this.bg = bg;
  }
}

const COLORS = ["red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray", "#e5c07b", "#61afef"];
const TOTAL = 20000;
const rowAt = (n: number): Row => {
  const runs: Run[] = [];
  for (let i = 0; i < 10; i++) runs.push(new Run("tok" + String(n) + "_" + String(i) + " ", COLORS[(n + i) % 10], i === 0));
  return new Row(runs, n % 7 === 0 ? "#203020" : "");
};

class LineProbe extends View {
  readonly rows: Signal<Row[]> = signal<Row[]>([]);
  override render(): unknown {
    return html`<div flex=1>${this.rows.value.map((r) => html`<p wrap="none" bg=${r.bg.length > 0 ? r.bg : "default"}>${r.runs.map((run) => html`<span fg=${run.fg} bold=${run.bold}>${run.text}</span>`)}</p>`)}</div>`;
  }
}

const W = 200;
const H = 200;
const root = new TRoot();
const view = new LineProbe();
mount(view, root);
const screen = new Screen(W, H);
const frame = (top: number): void => {
  const rows: Row[] = [];
  for (let i = 0; i < H; i++) rows.push(rowAt((top + i) % TOTAL));
  view.rows.value = rows;
  frames.flush();
  layout(root, W, H, DEFAULT_STYLE);
  screen.clear();
  paint(root, screen, new Clip(0, 0, W, H), DEFAULT_STYLE, new Caret(), null);
};
let t0 = Date.now();
frame(0);
const firstMs = Date.now() - t0;
console.log(screen.text().split("\n")[0].slice(0, 60));
t0 = Date.now();
for (let top = 1; top <= 100; top++) frame(top);
const perFrame = (Date.now() - t0) / 100;
console.log(screen.text().split("\n")[0].slice(0, 60));
process.stderr.write("first frame " + String(firstMs) + " ms; scroll frame " + perFrame.toFixed(1) + " ms (200 rows x 10 runs)\n");
