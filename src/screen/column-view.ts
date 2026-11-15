// One of the columns side by side: a box with a cell border in the column's accent over its tint,
// its tabs (or its title) on a row above its top edge, the active one in the full accent and the
// only one with side lines (the others draw the side along a border the pointer is on), drawn a
// quarter cell thick; its content kept its side padding off the border. Named by the shell's
// template as `<wc-column column title tabs shown ?active drop edge left right .view>` (`tabs` the
// labels joined with "\n", `shown` the shown one), its width and flex the box's own; the mouse's
// press, move, hover and release bubble to the shell, which turns a press on a border into a drag
// resizing the column, on a tab into showing it, and on the top edge into a drag moving the column.
import { View, define, html } from "@lightstart/light/native/tui";
import { palette } from "@lightstart/tui/palette.ts";

export class ColumnView extends View {
  column = this.prop("column", "");
  title = this.prop("title", "");
  tabs = this.prop("tabs", "");
  shown = this.prop("shown", -1);
  active = this.prop("active", false);
  /** Where a dragged column would drop: drawn on `palette.dropBg` with the dragged one's accent. */
  drop = this.prop("drop", "");
  /** The side along a border the pointer is over or drags ("left", "right", "" for none): drawn so the handle shows. */
  edge = this.prop("edge", "");
  left = this.prop("left", 0);
  right = this.prop("right", 0);
  view = this.prop<View | null>("view", null);

  override render(): unknown {
    const active = this.active.value;
    const id = this.column.value;
    const drop = this.drop.value;
    const line = drop !== "" ? palette.accentOf(drop) : palette.lineOf(id, active);
    const tint = drop !== "" ? palette.dropBg : palette.tintOf(id, false);
    return html`<div flex=1 border borderStyle="cell" borderColor=${line} borderSides=${active || drop !== "" ? "both" : this.edge.value !== "" ? this.edge.value : "none"} ?borderHeavy=${active || drop !== ""} bg=${tint} title=${this.title.value} tabs=${this.tabs.value} activeTab=${this.shown.value}><div flex=1 direction="row"><div width=${this.left.value}></div><div flex=1 fg=${palette.paneText}>${this.view.value}</div><div width=${this.right.value}></div></div></div>`;
  }
}

define("wc-column", ColumnView);
