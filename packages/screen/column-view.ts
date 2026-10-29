// One of the columns side by side: a bordered box titled with the column's name, the active one
// marked on its title and its border, its content kept its side padding off the border. Named by
// the shell's template as `<wc-column title ?active left right .view>`, its width and flex the
// box's own; the mouse's press, move and release bubble to the shell, which turns a press on a
// border into a drag resizing the column.
import { View, define, html } from "@lightstart/light/native/tui";
import { palette } from "@light/ui/palette.ts";

export class ColumnView extends View {
  title = this.prop("title", "");
  active = this.prop("active", false);
  left = this.prop("left", 0);
  right = this.prop("right", 0);
  view = this.prop<View | null>("view", null);

  override render(): unknown {
    const active = this.active.value;
    return html`<div flex=1 border title=${(active ? "▶ " : "  ") + this.title.value} fg=${active ? palette.activeBorder : palette.border}><div flex=1 direction="row"><div width=${this.left.value}></div><div flex=1 fg=${palette.paneText}>${this.view.value}</div><div width=${this.right.value}></div></div></div>`;
  }
}

define("wc-column", ColumnView);
