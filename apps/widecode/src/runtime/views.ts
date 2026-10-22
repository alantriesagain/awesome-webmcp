// What JS plugins draw, drawn by the core. A row is `{ bg, runs: [{ text, fg, bg, bold, dim,
// italic, underline, live }] }` or a plain string; a live run ("spinner") is drawn as the spinner's
// current frame, and a band moves it on each tick from the lines it already holds. JsRows is a LineSource over a plugin's `count()` and
// `rows(from, count, width)`: rows are fetched a window at a time and kept until the plugin
// refreshes, so a frame asks JS once for what it shows. JsPanel is a side tab over JsRows, its info
// row and presses from the plugin; JsBand a strip of the status band from the plugin's
// `lines(width)`.
import { Panel } from "@widecode/screen/contributions.ts";
import { isRecord, parseJson } from "@light/lib/json.ts";
import { Line, LinePress, LineSource, LineView, Run } from "@light/ui/line-view.ts";
import { type CustomEvent, View, html } from "@bootstrapp/light/native/tui";
import { Bridge, OK } from "@light/plugins/engine.ts";
import { cells } from "../api/values.ts";
import { PANEL_SLOTS, slotOf } from "./slots.ts";

/** Rows fetched per call into JS. */
const WINDOW = 64;

/** A panel's functions by slot, in the order `PANEL_SLOTS` names. */
const COUNT = slotOf(PANEL_SLOTS, "count");
const ROWS = slotOf(PANEL_SLOTS, "rows");
const INFO = slotOf(PANEL_SLOTS, "info");
const WIDTH = slotOf(PANEL_SLOTS, "width");
const PRESS = slotOf(PANEL_SLOTS, "press");
const INFO_PRESS = slotOf(PANEL_SLOTS, "infoPress");
const SHOWN = slotOf(PANEL_SLOTS, "shown");
const BADGE = slotOf(PANEL_SLOTS, "badge");
const HIDDEN = slotOf(PANEL_SLOTS, "hidden");
export const PANEL_FNS = PANEL_SLOTS.length;

interface RunFields {
  text?: unknown;
  fg?: unknown;
  bg?: unknown;
  bold?: unknown;
  dim?: unknown;
  italic?: unknown;
  underline?: unknown;
  live?: unknown;
  runs?: unknown;
}

const fieldsOf = (v: unknown): RunFields | null => (isRecord(v) ? (v as RunFields) : null);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** A run from what a plugin wrote; colors the terminal would refuse are dropped. */
export const runOf = (v: unknown): Run => {
  if (typeof v === "string") return new Run(v, "");
  const f = fieldsOf(v);
  const r = new Run(f !== null ? text(f.text) : "", f !== null ? safeColor(text(f.fg)) : "");
  if (f === null) return r;
  r.bg = safeColor(text(f.bg));
  r.bold = f.bold === true;
  r.dim = f.dim === true;
  r.italic = f.italic === true;
  r.underline = f.underline === true;
  r.live = f.live === "spinner" ? "spinner" : "";
  return r;
};

/** The runs of a value that is a run list, else []. */
export const runsOf = (v: unknown): Run[] => {
  const out: Run[] = [];
  if (Array.isArray(v)) for (const r of v as unknown[]) out.push(runOf(r));
  return out;
};

/** A line from a row a plugin wrote: a string, or `{ bg, runs }`. */
export const lineOf = (v: unknown): Line => {
  const l = new Line();
  if (typeof v === "string") {
    l.add(v, "");
    return l;
  }
  const f = fieldsOf(v);
  if (f === null) return l;
  l.bg = safeColor(text(f.bg));
  for (const r of runsOf(f.runs)) l.runs.push(r);
  return l;
};

const COLOR = /^(#[0-9a-fA-F]{6}|[0-9]{1,3}|default|gray|grey|black|red|green|yellow|blue|magenta|cyan|white|bright(black|red|green|yellow|blue|magenta|cyan|white))$/;
const safeColor = (c: string): string => (COLOR.test(c) ? c : "");



export class JsRows extends LineSource {
  readonly runtime: Bridge;
  readonly owner: string;
  readonly countFn: number;
  readonly rowsFn: number;
  private total = -1;
  private from = 0;
  private width = -1;
  private cached: Line[] = [];

  constructor(runtime: Bridge, owner: string, countFn: number, rowsFn: number) {
    super();
    this.runtime = runtime;
    this.owner = owner;
    this.countFn = countFn;
    this.rowsFn = rowsFn;
  }

  /** Forget what was fetched: the plugin's rows changed. */
  invalidate(): void {
    this.total = -1;
    this.cached = [];
  }

  count(): number {
    if (this.total < 0) {
      const r = this.runtime.invoke(this.owner, this.countFn, "[]");
      const n = r.status === OK ? parseJson(r.text) : 0;
      this.total = typeof n === "number" && n > 0 ? Math.floor(n) : 0;
    }
    return this.total;
  }

  line(index: number, width: number): Line {
    if (width !== this.width || index < this.from || index >= this.from + this.cached.length) {
      this.width = width;
      this.from = index;
      this.cached = [];
      const r = this.runtime.invoke(this.owner, this.rowsFn, JSON.stringify([index, WINDOW, width]));
      const rows = r.status === OK ? parseJson(r.text) : null;
      if (Array.isArray(rows)) for (const row of rows as unknown[]) this.cached.push(lineOf(row));
    }
    const at = index - this.from;
    return at < this.cached.length ? this.cached[at] : new Line();
  }
}

/** A side tab a JS plugin draws. */
export class JsPanel extends Panel {
  readonly runtime: Bridge;
  readonly rows: JsRows;
  readonly infoFn: number;
  readonly widthFn: number;
  readonly pressFn: number;
  readonly infoPressFn: number;
  readonly shownFn: number;
  readonly badgeFn: number;
  readonly hiddenFn: number;

  constructor(runtime: Bridge, owner: string, id: string, title: string, order: number, fns: number[]) {
    super(id, title, order);
    this.runtime = runtime;
    this.rows = new JsRows(runtime, owner, fns[COUNT], fns[ROWS]);
    this.infoFn = fns[INFO];
    this.widthFn = fns[WIDTH];
    this.pressFn = fns[PRESS];
    this.infoPressFn = fns[INFO_PRESS];
    this.shownFn = fns[SHOWN];
    this.badgeFn = fns[BADGE];
    this.hiddenFn = fns[HIDDEN];
    this.view.setSource(this.rows);
  }

  override press(index: number, column: number): void {
    if (this.pressFn >= 0) this.runtime.invoke(this.owner, this.pressFn, JSON.stringify([index, column]));
  }

  refresh(): void {
    this.rows.invalidate();
    this.touch();
    this.view.refresh();
  }

  override info(): Run[] {
    this.version.value;
    if (this.infoFn < 0) return [];
    const r = this.runtime.invoke(this.owner, this.infoFn, "[]");
    return r.status === OK ? runsOf(parseJson(r.text)) : [];
  }

  override infoPress(x: number): void {
    if (this.infoPressFn >= 0) this.runtime.invoke(this.owner, this.infoPressFn, JSON.stringify([x]));
  }

  override width(cols: number): number {
    if (this.widthFn < 0) return super.width(cols);
    const r = this.runtime.invoke(this.owner, this.widthFn, JSON.stringify([cols]));
    return cells(r.status === OK ? parseJson(r.text) : null, super.width(cols));
  }

  override shown(): void {
    if (this.shownFn >= 0) this.runtime.invoke(this.owner, this.shownFn, "[]");
  }

  override hidden(): void {
    if (this.hiddenFn >= 0) this.runtime.invoke(this.owner, this.hiddenFn, "[]");
  }

  override badge(): Run[] {
    this.version.value;
    if (this.badgeFn < 0) return [];
    const r = this.runtime.invoke(this.owner, this.badgeFn, "[]");
    return r.status === OK ? runsOf(parseJson(r.text)) : [];
  }
}

/** A strip of the status band a JS plugin draws. */
export class JsBand extends View {
  readonly runtime: Bridge;
  readonly id: string;
  readonly owner: string;
  readonly linesFn: number;
  readonly pressFn: number;
  /** The plugin's lines, fetched at the width the view measured and kept until a refresh. */
  readonly rows: JsLines;
  /** Every line, no window and no bar, as tall as the lines; a live run (the spinner) moves on each tick without asking the plugin again. */
  readonly view = new LineView();

  constructor(runtime: Bridge, id: string, owner: string, linesFn: number, pressFn: number) {
    super();
    this.box.flex = 1;
    this.runtime = runtime;
    this.id = id;
    this.owner = owner;
    this.linesFn = linesFn;
    this.pressFn = pressFn;
    this.rows = new JsLines(runtime, owner, linesFn);
    this.view.fit = true;
    this.view.setSource(this.rows);
  }

  /** Fetch the plugin's lines again on the next frame (they changed). */
  refresh(): void {
    this.rows.invalidate();
    this.view.refresh();
  }

  /** The strip's lines at `width` cells, fetched from the plugin. */
  lines(width: number): Line[] {
    return this.rows.fetch(width);
  }

  /** A press at `row`, column `x` of the strip. */
  pressAt(row: number, x: number): void {
    if (this.pressFn >= 0) this.runtime.invoke(this.owner, this.pressFn, JSON.stringify([row, x]));
  }

  override render(): unknown {
    return html`<div @press=${(e: CustomEvent) => {
      const press = e.detail;
      if (press instanceof LinePress) this.pressAt(press.index, press.column);
    }}>${this.view}</div>`;
  }
}

/** A strip's lines as the plugin draws them, fetched at a width and kept until the strip refreshes. */
class JsLines extends LineSource {
  readonly runtime: Bridge;
  readonly owner: string;
  readonly linesFn: number;
  private cached: Line[] | null = null;
  private width = -1;

  constructor(runtime: Bridge, owner: string, linesFn: number) {
    super();
    this.runtime = runtime;
    this.owner = owner;
    this.linesFn = linesFn;
  }

  /** Forget the lines: the plugin's changed. */
  invalidate(): void {
    this.cached = null;
  }

  /** The lines at `width` cells, fetched from the plugin and kept. */
  fetch(width: number): Line[] {
    const out: Line[] = [];
    const r = this.runtime.invoke(this.owner, this.linesFn, JSON.stringify([width]));
    const rows = r.status === OK ? parseJson(r.text) : null;
    if (Array.isArray(rows)) for (const row of rows as unknown[]) out.push(lineOf(row));
    this.cached = out;
    this.width = width;
    return out;
  }

  override prepare(width: number): void {
    const w = width > 0 ? width : 80;
    if (this.cached !== null && this.width === w) return;
    this.fetch(w);
  }

  count(): number {
    const c = this.cached;
    return c !== null ? c.length : 0;
  }

  line(index: number, _width: number): Line {
    const c = this.cached;
    return c !== null && index < c.length ? c[index] : new Line();
  }

  /** The first line holding a live run (the spinner), or the count. */
  override liveFrom(): number {
    const c = this.cached;
    if (c === null) return 0;
    for (let i = 0; i < c.length; i++) if (c[i].runs.some((run) => run.live.length > 0)) return i;
    return c.length;
  }
}
