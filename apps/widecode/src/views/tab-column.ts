// A tab column (the files column, the tools column): the shown tab's info row and its rows (the
// tabs are on the column's top edge, column-view.ts). A press on the info row goes to the panel.
// The host keeps which tab each column shows; each panel keeps its own view, so its scroll position
// survives a switch.
import { Host } from "../controllers/host.ts";
import { Panel } from "@widecode/screen/contributions.ts";
import { type CustomEvent, type MouseEvent, View, html } from "@lightstart/light/native/tui";
import { LinePress } from "@light/ui/line-view.ts";
import { colorOr } from "@light/ui/palette.ts";

export class TabColumn extends View {
  readonly host: Host;
  /** The column's id ("side", "tools"), which its tabs name. */
  readonly column: string;

  constructor(host: Host, column: string) {
    super();
    this.box.flex = 1;
    this.host = host;
    this.column = column;
  }

  /** The panel shown (the first one when the host names none). */
  current(): Panel | null {
    return this.host.screen.shownPanel(this.column);
  }

  override render(): unknown {
    this.host.screen.tabs.value;
    const panel = this.current();
    const info = panel !== null ? panel.info() : [];
    return html`<div flex=1 @press=${(e: CustomEvent) => {
      const press = e.detail;
      if (panel !== null && press instanceof LinePress) panel.press(press.index, press.column);
    }}>
      <p wrap="none" @mousedown=${(e: MouseEvent) => {
        if (e.button === 0 && panel !== null) panel.infoPress(e.x - this.box.x);
      }}>${info.map((r) => html`<span fg=${colorOr(r.fg)} bg=${colorOr(r.bg)} bold=${r.bold} dim=${r.dim}>${r.text}</span>`)}</p>
      ${panel !== null ? panel.view : null}
    </div>`;
  }
}
