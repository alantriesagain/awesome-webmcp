// The code column: the selected file with its changes against HEAD in place. A gutter holds the
// line number (HEAD's for a removed line) and the change sign; added and removed lines get a
// tinted background. A header names the file, its git mark and how many changes it has; n and p
// move between changes. The file reloads when the folder changes under it. With wrapping on (w,
// or the box in the footer) a long line breaks at a space where it can and continues on the rows
// below, under a blank gutter and at its own indentation; the view then counts rows, and changes,
// the position and n/p map between rows and code lines.
import { palette } from "@light/ui/palette.ts";
import { ADDED, CodeFile, CodeLine, REMOVED } from "./diff.ts";
import { languageForPath, TOKEN_COLORS, tokenStyle } from "@lightstart/highlight";
import { Line, LinePress, LineSource, LineView, Run } from "@light/ui/line-view.ts";
import { type CustomEvent, type MouseEvent, View, html, signal, sliceCells, stringWidth } from "@lightstart/light/native/tui";


/** A line's text as runs in its tokens' colors (removed lines a shade dimmer). */
const addText = (l: Line, c: CodeLine): void => {
  const base = c.kind === REMOVED ? palette.removedText : "";
  if (c.tokens.length === 0) {
    l.add(c.text, base);
    return;
  }
  let at = 0;
  for (const t of c.tokens) {
    if (t.from > at) l.add(c.text.slice(at, t.from), base);
    const run = l.add(c.text.slice(t.from, t.to), TOKEN_COLORS.get(t.type) ?? base);
    const style = tokenStyle(t.type);
    run.bold = style === "bold";
    run.italic = style === "italic";
    run.underline = style === "underline";
    if (c.kind === REMOVED) run.dim = true;
    at = t.to;
  }
  if (at < c.text.length) l.add(c.text.slice(at), base);
};

const PLAIN = /^[\x20-\x7e]*$/;

/** Each character's cells, for a line that is not plain ASCII. */
const cellWidths = (text: string): number[] => {
  const out: number[] = [];
  for (const ch of text) {
    const w = stringWidth(ch);
    out.push(w);
    if (ch.length === 2) out.push(0);
  }
  return out;
};

/**
 * Where `text`'s rows start (in cells) when it wraps at `cols`: a row breaks after the last space
 * that leaves it at least half full, else at the edge; rows after the first hold `cols - indent`.
 */
const wrapStarts = (text: string, cols: number, indent: number): number[] => {
  const plain = PLAIN.test(text);
  const widths = plain ? [] : cellWidths(text);
  const total = plain ? text.length : widths.reduce((a, b) => a + b, 0);
  const starts: number[] = [0];
  if (total <= cols) return starts;
  // Positions are characters; for plain text a character is a cell.
  const cellAt: number[] = [];
  let x = 0;
  for (let i = 0; i < text.length; i++) {
    cellAt.push(x);
    x += plain ? 1 : widths[i];
  }
  cellAt.push(x);
  let from = 0;
  let room = cols;
  while (total - cellAt[from] > room) {
    let end = from;
    while (end < text.length && cellAt[end + 1] - cellAt[from] <= room) end++;
    let cut = end;
    for (let i = end; i > from + Math.floor(room / 2); i--)
      if (text.charAt(i - 1) === " ") {
        cut = i;
        break;
      }
    if (cut <= from) cut = from + 1;
    starts.push(cellAt[cut]);
    from = cut;
    room = Math.max(8, cols - indent);
  }
  return starts;
};

/** The runs' cells [from, to), split where a run crosses either edge. */
const sliceRuns = (runs: Run[], from: number, to: number): Run[] => {
  const out: Run[] = [];
  let x = 0;
  for (const r of runs) {
    let text = "";
    for (const ch of r.text) {
      const w = stringWidth(ch);
      if (x >= from && x + w <= to) text += ch;
      x += w;
    }
    if (text.length > 0) out.push(r.restyle(text));
    if (x >= to) break;
  }
  return out;
};

export class CodeSource extends LineSource {
  file = new CodeFile();
  /** Long lines continue on the rows below. */
  wrap = false;
  private numWidth = 1;
  /** With wrapping: each code line's first row, each row's first cell and indentation, the rows in all, for the width and file they were counted at. */
  private rowStarts: number[] = [];
  private rowCells: number[] = [];
  private rowIndent: number[] = [];
  private rows = 0;
  private wrapWidth = -1;
  private wrapFile: CodeFile | null = null;

  setFile(file: CodeFile): void {
    this.file = file;
    let max = 0;
    for (const l of file.lines) max = Math.max(max, l.oldNo, l.newNo);
    this.numWidth = String(max).length;
  }

  /** The gutter's width: the number, a space, the sign and a space. */
  private gutter(): number {
    return this.numWidth + 2 + 2;
  }

  override prepare(width: number): void {
    if (!this.wrap || (width === this.wrapWidth && this.file === this.wrapFile)) return;
    this.wrapWidth = width;
    this.wrapFile = this.file;
    const cols = Math.max(8, width - this.gutter());
    const starts: number[] = [];
    const cells: number[] = [];
    const indents: number[] = [];
    for (const l of this.file.lines) {
      starts.push(cells.length);
      let indent = 0;
      while (indent < l.text.length && l.text.charAt(indent) === " ") indent++;
      indent = Math.min(indent, Math.floor(cols / 2));
      const rowStarts = wrapStarts(l.text, cols, indent);
      for (let i = 0; i < rowStarts.length; i++) {
        cells.push(rowStarts[i]);
        indents.push(i === 0 ? 0 : indent);
      }
    }
    this.rowStarts = starts;
    this.rowCells = cells;
    this.rowIndent = indents;
    this.rows = cells.length;
  }

  count(): number {
    return this.wrap ? this.rows : this.file.lines.length;
  }

  /** The first row of code line `line`. */
  rowOf(line: number): number {
    if (!this.wrap) return line;
    this.prepare(this.wrapWidth);
    return line < this.rowStarts.length ? this.rowStarts[line] : this.rows;
  }

  /** The code line row `row` belongs to. */
  lineOf(row: number): number {
    if (!this.wrap) return row;
    this.prepare(this.wrapWidth);
    let lo = 0;
    let hi = this.rowStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.rowStarts[mid] <= row) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  line(index: number, _width: number): Line {
    if (!this.wrap) return this.codeLine(index);
    const at = this.lineOf(index);
    const full = this.codeLine(at);
    const gutter = this.gutter();
    const next = index + 1 < this.rows && this.lineOf(index + 1) === at ? this.rowCells[index + 1] : 1 << 30;
    const l = new Line();
    l.bg = full.bg;
    if (index === this.rowStarts[at]) for (const r of sliceRuns(full.runs, 0, gutter)) l.runs.push(r);
    else l.add(" ".repeat(gutter + this.rowIndent[index]), "");
    for (const r of sliceRuns(full.runs, gutter + this.rowCells[index], gutter + next)) l.runs.push(r);
    return l;
  }

  /**
   * A copy is the file's own text: no gutter, a long line whole even where the pane cut it, a
   * wrapped one joined back. Rows `from` (from cell `fromCell`) to `to` (before cell `toCell`, -1
   * the end) are screen rows and cells.
   */
  override copyText(from: number, fromCell: number, to: number, toCell: number, width: number): string | null {
    this.prepare(width);
    const gutter = this.gutter();
    /** The cell of the code line's text under screen cell `cell` of row `row`. */
    const textCell = (row: number, cell: number): number => {
      const c = Math.max(0, cell - gutter);
      if (!this.wrap) return c;
      const first = row === this.rowStarts[this.lineOf(row)];
      return this.rowCells[row] + Math.max(0, c - (first ? 0 : this.rowIndent[row]));
    };
    const first = this.lineOf(from);
    const last = this.lineOf(to);
    const start = textCell(from, fromCell);
    // Unwrapped, a drag to the pane's right edge takes the rest of the line the pane cut.
    const end = toCell < 0 || (!this.wrap && toCell >= width - 1) ? -1 : textCell(to, toCell);
    const out: string[] = [];
    for (let i = first; i <= last && i < this.file.lines.length; i++) out.push(sliceCells(this.file.lines[i].text, i === first ? start : 0, i === last ? end : -1));
    return out.join("\n");
  }

  /** Code line `index` whole: its gutter and its text. */
  private codeLine(index: number): Line {
    const c = this.file.lines[index];
    const l = new Line();
    const no = c.kind === REMOVED ? c.oldNo : c.newNo;
    l.add(String(no).padStart(this.numWidth + 1, " ") + " ", c.kind === REMOVED ? palette.removedNumber : c.kind === ADDED ? palette.addedNumber : palette.lineNumber);
    if (c.kind === ADDED) {
      l.bg = palette.addedBg;
      l.add("+ ", palette.ok).bold = true;
    } else if (c.kind === REMOVED) {
      l.bg = palette.removedBg;
      l.add("- ", palette.bad).bold = true;
    } else l.add("  ", "");
    addText(l, c);
    return l;
  }
}

export class CodePane extends View {
  readonly view = new LineView();
  readonly source = new CodeSource();
  /** The git mark of the open file ("" for none). */
  readonly mark = signal("");
  readonly path = signal("");
  readonly header = signal("");
  /** The commit whose change is shown ("a1b2c3d Fix the lookup"); "" for the work tree. */
  readonly commit = signal("");
  /** What is shown in place of the file, a subagent's steps or a tool call ("Agent · Explore: Find callers"); "" for none. Its lines come from another source. */
  readonly agent = signal("");
  /** Where the file's view was when a subagent or a call took its place. */
  private fileTop = 0;
  /** What a press on a row does while a subagent's steps or a plugin's rows are shown; null for a file. */
  onPress: ((index: number) => void) | null = null;

  constructor() {
    super();
    this.box.flex = 1;
    this.view.setSource(this.source);
  }

  /** Long lines wrapped onto the rows below (the footer's box shows it). */
  readonly wrap = signal(false);
  /** Called after wrapping was turned on or off. */
  onWrap: (() => void) | null = null;

  /** Wrap long lines, or stop; the line at the top stays at the top. */
  toggleWrap(): void {
    const s = this.source;
    const top = s.lineOf(this.view.top);
    s.wrap = !s.wrap;
    s.prepare(this.view.cols);
    this.view.top = s.rowOf(top);
    this.view.follow = false;
    this.wrap.value = s.wrap;
    this.view.refresh();
    const fn = this.onWrap;
    if (fn !== null) fn();
  }

  /** Show `file` as `commit` changed it (Esc returns to the work tree). */
  showCommit(file: CodeFile, mark: string, commit: string): void {
    this.commit.value = commit;
    this.source.setFile(new CodeFile());
    this.show(file, mark);
    this.commit.value = commit;
  }

  /** Show a subagent's steps or a call (`source`) in place of the file, titled `title`; `running`, they follow its newest step. */
  showAgent(source: LineSource, title: string, running: boolean): void {
    if (this.agent.peek().length === 0) this.fileTop = this.view.top;
    this.agent.value = title;
    this.view.show(source, running);
  }

  /** Back to the file from a subagent, where its view was. */
  private leaveAgent(): void {
    if (this.agent.peek().length === 0) return;
    this.agent.value = "";
    this.onPress = null;
    this.view.followable = false;
    this.view.follow = false;
    this.view.setSource(this.source);
    this.view.top = this.fileTop;
  }

  /** Show `file`; a reload of the same path keeps the scroll position. */
  show(file: CodeFile, mark: string): void {
    this.leaveAgent();
    this.commit.value = "";
    const same = file.path === this.source.file.path;
    this.source.setFile(file);
    this.mark.value = mark;
    this.path.value = file.path;
    const n = file.hunks.length;
    const parts: string[] = [];
    if (!file.exists && file.lines.length > 0) parts.push("deleted");
    if (file.added) parts.push("new file");
    if (n > 0) parts.push(n === 1 ? "1 change" : String(n) + " changes");
    if (file.note.length > 0) parts.push(file.note);
    this.header.value = parts.join(" · ");
    if (same) this.view.refresh();
    else {
      this.view.top = 0;
      this.view.refresh();
      if (n > 0) this.view.reveal(this.source.rowOf(file.hunks[0]), true);
    }
  }

  /** Show nothing (another folder is opening). */
  clear(): void {
    this.leaveAgent();
    this.source.setFile(new CodeFile());
    this.mark.value = "";
    this.path.value = "";
    this.header.value = "";
    this.commit.value = "";
    this.view.top = 0;
    this.view.refresh();
  }

  /** Where the view is: "change 2/5 · L40" (the change at or above its top third, that line's number); "" for no file. */
  position(): string {
    const lines = this.source.file.lines;
    if (lines.length === 0 || this.agent.peek().length > 0) return "";
    const anchor = Math.min(lines.length - 1, this.source.lineOf(this.view.top + Math.floor(Math.max(1, this.view.rows) / 3)));
    const hunks = this.source.file.hunks;
    let at = 1;
    for (let i = 0; i < hunks.length; i++) if (hunks[i] <= anchor) at = i + 1;
    const l = lines[anchor];
    const no = l.newNo > 0 ? l.newNo : l.oldNo;
    return (hunks.length > 0 ? "change " + String(at) + "/" + String(hunks.length) + " · " : "") + "L" + String(no);
  }

  /** Move to the next (1) or previous (-1) change after or before the top third of the view. */
  moveHunk(direction: number): void {
    const hunks = this.source.file.hunks;
    if (hunks.length === 0 || this.agent.peek().length > 0) return;
    const anchor = this.source.lineOf(this.view.top + Math.floor(Math.max(1, this.view.rows) / 3));
    let target = -1;
    if (direction > 0) {
      for (const h of hunks)
        if (h > anchor) {
          target = h;
          break;
        }
      if (target < 0) target = hunks[0];
    } else {
      for (let i = hunks.length - 1; i >= 0; i--)
        if (hunks[i] < anchor) {
          target = hunks[i];
          break;
        }
      if (target < 0) target = hunks[hunks.length - 1];
    }
    this.view.reveal(this.source.rowOf(target), true);
  }

  override render(): unknown {
    const path = this.path.value;
    const mark = this.mark.value;
    const header = this.header.value;
    const commit = this.commit.value;
    const agent = this.agent.value;
    if (agent.length > 0)
      return html`<div flex=1 @press=${(e: CustomEvent) => this.pressed(e)}>
      <p wrap="none" bg=${palette.bandBg}><span fg=${palette.think} bold>${" " + agent}</span><span fg=${palette.dim}>${" · Esc back to " + (path.length > 0 ? path : "the code")}</span></p>
      ${this.view}
    </div>`;
    return html`<div flex=1>
      <p wrap="none" bg=${palette.bandBg}><span bold>${" " + (path.length > 0 ? path : "no file")}</span><span fg=${palette.markColors().get(mark) ?? "default"} bold>${mark.length > 0 ? " " + mark : ""}</span><span fg=${palette.think}>${commit.length > 0 ? " @ " + commit : ""}</span><span fg=${palette.dim}>${header.length > 0 ? "  " + header : ""}${commit.length > 0 ? " · Esc back to the work tree" : ""}</span></p>
      ${this.view}
      <div direction="row" bg=${palette.bandBg}><div flex=1><p wrap="none"><span fg=${palette.dim}>${this.footer(path)}</span></p></div><div @mousedown=${(e: MouseEvent) => {
        if (e.button === 0) this.toggleWrap();
      }}><p wrap="none"><span fg=${this.wrap.value ? palette.link : palette.dim} bold=${this.wrap.value}>${this.wrap.value ? "[x] " : "[ ] "}</span><span fg=${palette.dim}>wrap lines </span></p></div></div>
    </div>`;
  }

  /** A press on a row of what is shown in place of the file. */
  private pressed(e: CustomEvent): void {
    const press = e.detail;
    const fn = this.onPress;
    if (press instanceof LinePress && fn !== null) fn(press.index);
  }

  /** The footer's left side: the file's language and its lines. */
  private footer(path: string): string {
    if (path.length === 0) return "";
    const language = languageForPath(path);
    const n = this.source.file.lines.length;
    return " " + (language.length > 0 ? language + " · " : "") + String(n) + (n === 1 ? " line" : " lines");
  }
}
