// A tab column's tabs, as links on the status band under it: a grid three rows high, filled a
// column at a time (Files, Sessions, Git, then any plugin's tab), each link its title and the badge
// its plugin gives (a count, ahead and behind), the shown one highlighted. A press shows the tab;
// Tab in the column still moves through them.
import { Host } from "../controllers/host.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { type MouseEvent, View, html, stringWidth } from "@lightstart/light/native/tui";
import { colorOr, palette } from "@light/ui/palette.ts";

const ROWS = 3;

/** Where a link is drawn, for presses. */
class Link {
  readonly id: string;
  readonly row: number;
  readonly x: number;
  readonly w: number;

  constructor(id: string, row: number, x: number, w: number) {
    this.id = id;
    this.row = row;
    this.x = x;
    this.w = w;
  }
}

export class TabLinks extends View {
  readonly host: Host;
  /** The tab column whose tabs it links. */
  readonly column: string;
  private links: Link[] = [];
  /** The grid's width in cells, from the last layout. */
  private used = 0;

  constructor(host: Host, column: string) {
    super();
    this.box.flex = 1;
    this.host = host;
    this.column = column;
  }

  /** The rows of links: each tab's runs placed a column at a time, three to a column. */
  private rows(): Run[][] {
    const shown = this.host.screen.shownIn(this.column);
    const panels = this.host.screen.panelsIn(this.column);
    const cells: Run[][] = [];
    for (const p of panels) {
      const on = p.id === shown;
      const title = new Run(" " + p.title, on ? palette.link : palette.dim);
      title.bold = on;
      const cell = [title];
      const badge = p.badge();
      if (badge.length > 0) cell.push(new Run(" ", ""));
      for (const r of badge) cell.push(r);
      cell.push(new Run(" ", ""));
      if (on) for (const r of cell) r.bg = palette.selectedBg;
      cells.push(cell);
    }
    const rows: Run[][] = [];
    for (let r = 0; r < ROWS; r++) rows.push([]);
    const widths: number[] = [];
    for (let i = 0; i < cells.length; i += ROWS) widths.push(0);
    cells.forEach((cell: Run[], i: number) => {
      const col = Math.floor(i / ROWS);
      let w = 0;
      for (const r of cell) w += stringWidth(r.text);
      widths[col] = Math.max(widths[col], w);
    });
    const links: Link[] = [];
    let x = 0;
    for (let col = 0; col < widths.length; col++) {
      for (let row = 0; row < ROWS; row++) {
        const i = col * ROWS + row;
        if (i >= cells.length) break;
        const line = rows[row];
        let used = 0;
        for (const r of line) used += stringWidth(r.text);
        if (used < x) line.push(new Run(" ".repeat(x - used), ""));
        for (const r of cells[i]) line.push(r);
        links.push(new Link(panels[i].id, row, x, widths[col]));
      }
      x += widths[col] + 1;
    }
    this.links = links;
    this.used = x;
    return rows;
  }

  /** How wide the links are, to sit beside another strip at that width. */
  cells(): number {
    this.rows();
    return this.used;
  }

  private press(e: MouseEvent): void {
    if (e.button !== 0) return;
    const row = e.y - this.box.y;
    const x = e.x - this.box.x;
    for (const l of this.links)
      if (l.row === row && x >= l.x && x < l.x + l.w) {
        this.host.screen.showPanel(l.id);
        return;
      }
  }

  override render(): unknown {
    this.host.screen.layout.value;
    const rows = this.rows();
    return html`<div flex=1 @mousedown=${(e: MouseEvent) => this.press(e)}>${rows.map(
      (r) => html`<p wrap="none">${r.map((run) => html`<span fg=${colorOr(run.fg)} bg=${colorOr(run.bg)} bold=${run.bold} dim=${run.dim}>${run.text}</span>`)}</p>`,
    )}</div>`;
  }
}
