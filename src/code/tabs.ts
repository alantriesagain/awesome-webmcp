// The code column's tabs: the permanent Code tab, whose pane keeps the open file, its path and its
// scroll, and the item tabs opened beside it, each with a view of its own. The host answers the
// labels and the active index and turns a press on a label into a show or a close (the last two
// cells of a closable label close it); its view draws the active tab's view.
import { ColumnTabHost } from "../screen/contributions.ts";
import { View, batch, html, signal } from "@lightstart/light/native/tui";
import { clipText } from "@lightstart/tui/text.ts";

/** Cells a closable tab's title keeps before its close mark. */
const LABEL_CELLS = 24;

/** One tab of the code column: its id, its label, whether it closes, and the view it shows. */
export class CodeTab {
  readonly id: string;
  readonly title: string;
  readonly closeable: boolean;
  readonly view: View;

  constructor(id: string, title: string, closeable: boolean, view: View) {
    this.id = id;
    this.title = title;
    this.closeable = closeable;
    this.view = view;
  }
}

/** The code column's tabs: Code first and always, the item tabs after it. */
export class CodeTabHost extends ColumnTabHost {
  readonly code: CodeTab;
  /** The tabs opened beside Code, left to right. */
  readonly items = signal<readonly CodeTab[]>([]);
  /** The index of the tab shown (0 is Code). */
  readonly shown = signal(0);
  /** The view the column draws: the active tab's. */
  readonly view: View;

  constructor(pane: View) {
    super();
    this.code = new CodeTab("code", "Code", false, pane);
    this.view = new CodeTabHostView(this);
  }

  labels(): string[] {
    const out: string[] = [this.code.title];
    for (const tab of this.items.value) out.push(tab.closeable ? clipText(tab.title, LABEL_CELLS) + " ×" : tab.title);
    return out;
  }

  activeIndex(): number {
    return this.shown.value;
  }

  /** A press on tab `index`: the last two cells of a closable label close it, anywhere else shows it. */
  press(index: number, x: number, end: number): void {
    const tab = this.at(index);
    if (tab === null) return;
    if (tab.closeable && x >= end - 2) this.close(index);
    else this.show(index);
  }

  /** Show tab `index` (0 is Code). */
  show(index: number): void {
    if (this.at(index) !== null) this.shown.value = index;
  }

  /** Close the closable tab at `index`, showing the tab before it (Code when it was the first item). */
  close(index: number): void {
    const tab = this.at(index);
    if (tab === null || !tab.closeable) return;
    batch(() => {
      this.items.value = this.items.peek().filter((_, i) => i !== index - 1);
      this.shown.value = Math.max(0, index - 1);
    });
  }

  /** Open `tab`: show it when its id is open already, else add it after the others and show it. */
  open(tab: CodeTab): void {
    const found = this.indexOf(tab.id);
    if (found >= 0) {
      this.show(found);
      return;
    }
    batch(() => {
      this.items.value = [...this.items.peek(), tab];
      this.shown.value = this.items.peek().length;
    });
  }

  /** The tab shown. */
  active(): CodeTab {
    return this.at(this.shown.value) ?? this.code;
  }

  private indexOf(id: string): number {
    if (this.code.id === id) return 0;
    const items = this.items.peek();
    for (let i = 0; i < items.length; i++) if (items[i].id === id) return i + 1;
    return -1;
  }

  private at(index: number): CodeTab | null {
    if (index === 0) return this.code;
    const items = this.items.value;
    if (index > 0 && index <= items.length) return items[index - 1];
    return null;
  }
}

/** The column's view: the active tab's view, drawn again when the tabs or the shown one change. */
class CodeTabHostView extends View {
  readonly host: CodeTabHost;

  constructor(host: CodeTabHost) {
    super();
    this.box.flex = 1;
    this.host = host;
  }

  override render(): unknown {
    return html`<div flex=1>${this.host.active().view}</div>`;
  }
}
