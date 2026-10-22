// The screen: the columns plugins registered, left to right (among them the tab columns, the files
// column and the tools column beside the chat, while plugins registered tabs for them:
// tab-column.ts), and the status band under them. Keys go to the kernel's bindings in the scopes in
// effect (a tab column's shown tab, the active column, anywhere), and the active column's input has
// the terminal's focus. The shell's own keys: Ctrl+C (interrupt the agent, then quit), F12 (the
// screen's text to the log), F1 (chat), F2 (files), F3 (code), F6 (tools) and Ctrl+←/→ between the
// columns, PgUp/PgDn (half a page), Esc (interrupt the agent), Tab through a tab column's tabs; /help, written from
// every command and key binding registered, and /columns. The columns are as wide as column-widths.ts
// says; a drag on the border between two resizes them, and state.json keeps what it left.
import { Host } from "../controllers/host.ts";
import { BandPart, Column } from "@widecode/screen/contributions.ts";
import { Action, Binder } from "@light/kernel/actions.ts";
import { joinLabels } from "@light/kernel/keys.ts";
import { type CustomEvent, type KeyEvent, type MouseEvent, View, html, signal, key } from "@bootstrapp/light/native/tui";
import { LineCopy } from "@light/ui/line-view.ts";
import { ColumnWidths } from "./column-widths.ts";
import { TabColumn } from "./tab-column.ts";
import { TabLinks } from "./tab-links.ts";
import "@widecode/screen/column-view.ts";
import { palette } from "@light/ui/palette.ts";
import { trail } from "@light/lib/log.ts";

/** A key as the trail names it: its modifiers and name, a character only with Ctrl or Alt (what is typed stays out of the log). */
const keyName = (e: KeyEvent): string => (e.ctrl ? "ctrl+" : "") + (e.alt ? "alt+" : "") + (e.shift ? "shift+" : "") + (e.key === "char" ? (e.ctrl || e.alt ? "char:" + e.text : "char") : e.key);


/** A tab column the shell adds while tabs name it: its id, its title before a tab shows, where it goes. */
class TabColumnSpec {
  readonly id: string;
  readonly title: string;
  readonly order: number;

  constructor(id: string, title: string, order: number) {
    this.id = id;
    this.title = title;
    this.order = order;
  }
}

/** The tools column right of the chat (order 0), the files column after it. */
const TAB_COLUMNS = [new TabColumnSpec("tools", "Tools", 0.5), new TabColumnSpec("side", "Files", 1)];
/** A border being dragged: the column it resizes, where the press was, its width then, and +1 when it is the border's left column (-1, its right). */
class BorderDrag {
  readonly id: string;
  readonly from: number;
  readonly start: number;
  readonly sign: number;

  constructor(id: string, from: number, start: number, sign: number) {
    this.id = id;
    this.from = from;
    this.start = start;
    this.sign = sign;
  }
}

/** The column each function key makes active. */
const FKEYS = ["f1", "f2", "f3", "f6"];
const FKEY_COLUMNS = ["chat", "side", "code", "tools"];

export class Shell extends View {
  readonly host: Host;
  /** The tab columns (by id: "side", "tools") and their tabs' links, on the band under each. */
  readonly tabs = new Map<string, TabColumn>();
  readonly links = new Map<string, TabLinks>();
  private readonly cols = signal(160);
  private lastCtrlC = 0;
  /** The columns' widths: config.json's, a drag's; `resized` moves when a drag changes one. */
  readonly sizes = new ColumnWidths();
  private readonly resized = signal(0);
  private drag: BorderDrag | null = null;

  constructor(host: Host) {
    super();
    this.box.flex = 1;
    this.host = host;
    for (const spec of TAB_COLUMNS) {
      this.tabs.set(spec.id, new TabColumn(host, spec.id));
      this.links.set(spec.id, new TabLinks(host, spec.id));
    }
    this.addKeys();
  }

  /** Once the plugins started: the /help hint last, the tab columns that have tabs, the widths a drag left. */
  finish(): void {
    this.host.kernel.actions.add(new Action("app.help", "", "/help", [], "shell", (_key: KeyEvent, _count: number) => false));
    this.side();
    this.sizes.restore(this.host.kernel.settings.state("columns"));
  }

  /** The tab columns, each added while plugins registered tabs for it and dropped when none are left. */
  side(): void {
    const h = this.host;
    for (const spec of TAB_COLUMNS) {
      const tabs = this.tabs.get(spec.id);
      const links = this.links.get(spec.id);
      if (tabs === undefined || links === undefined) continue;
      // Owned per column, so one goes without the other.
      const owner = "shell:" + spec.id;
      const has = h.screen.column(spec.id) !== null;
      if (h.screen.panelsIn(spec.id).length === 0) {
        if (has) h.removeOwner(owner);
        continue;
      }
      if (has) continue;
      // As wide as the shown panel asks; its tabs' links go on the band under it.
      h.screen.addColumn(owner, new Column(spec.id, spec.title, spec.order, tabs, (cols: number) => {
        const p = tabs.current();
        return p !== null ? p.width(cols) : 24;
      }, 0, 0, null, null));
      h.screen.addBand(owner, new BandPart("tabs:" + spec.id, spec.id, 0, links));
    }
  }

  resize(cols: number): void {
    this.cols.value = cols;
  }

  /** A key from the terminal: true when an action took it. The composer's text before it goes on its undo stack when the key changed it. */
  handleKey(e: KeyEvent): boolean {
    trail.reset();
    const d = trail.enter("key", keyName(e));
    const composer = this.host.roles.chat.composer;
    const before = composer !== null ? composer.snapshot() : null;
    const id = this.host.kernel.keys.dispatch(e, this.host.screen.scopes());
    if (composer !== null && before !== null) composer.record(before, id);
    trail.leave(d);
    return id.length > 0;
  }

  /** The columns' widths at `cols` terminal columns, in their order (0 for the one taking the rest). */
  private laidOut(cols: number): number[] {
    const columns = this.host.screen.columns;
    return this.sizes.layout(
      columns.map((c) => c.id),
      columns.map((c) => c.widthAt(cols)),
      cols,
    );
  }

  /** The columns' widths at the terminal's width, in their order (0 for the one taking the rest). */
  widths(): number[] {
    return this.laidOut(this.cols.peek());
  }

  /** Column `id`'s width at the terminal's width (0 for the one taking the rest, -1 for none). */
  widthOf(id: string): number {
    const at = this.host.screen.columns.findIndex((c) => c.id === id);
    return at >= 0 ? this.widths()[at] : -1;
  }

  /** Where column `id` starts: the widths of the columns left of it (-1 for none). */
  xOf(id: string): number {
    const widths = this.widths();
    let x = 0;
    for (let i = 0; i < this.host.screen.columns.length; i++) {
      if (this.host.screen.columns[i].id === id) return x;
      x += widths[i];
    }
    return -1;
  }

  /** A left press on column `index`: on its border with a neighbour, a drag starts resizing them; else the column becomes active. */
  private pressColumn(index: number, e: MouseEvent): void {
    if (e.button !== 0) return;
    const cols = this.cols.peek();
    const widths = this.laidOut(cols);
    // The column taking the rest is as wide as the others leave.
    let fixed = 0;
    for (const w of widths) fixed += w;
    const shown = widths.map((w) => (w > 0 ? w : Math.max(0, cols - fixed)));
    let x = 0;
    for (let i = 0; i < index; i++) x += shown[i];
    const columns = this.host.screen.columns;
    // The border between columns a and b: the one with a width of its own changes (the code column takes the rest).
    let a = -1;
    if (e.x === x + shown[index] - 1 && index < columns.length - 1) a = index;
    else if (e.x === x && index > 0) a = index - 1;
    if (a >= 0) {
      const left = widths[a] > 0;
      const target = left ? a : a + 1;
      if (widths[target] > 0) {
        this.drag = new BorderDrag(columns[target].id, e.x, shown[target], left ? 1 : -1);
        return;
      }
    }
    const id = columns[index].id;
    if (this.host.screen.active.peek() !== id) this.host.screen.focus(id);
  }

  /** The border follows the pointer while it is held. */
  private dragBorder(e: MouseEvent): void {
    const d = this.drag;
    if (d === null) return;
    this.sizes.drag(d.id, d.start + d.sign * (e.x - d.from));
    this.resized.value = this.resized.peek() + 1;
  }

  /** Let go: the width stays, kept in state.json for the next run. */
  private dropBorder(e: MouseEvent): void {
    if (this.drag === null) return;
    this.dragBorder(e);
    this.drag = null;
    this.host.kernel.settings.setState("columns", this.sizes.kept());
  }

  /** The columns' widths now, and how to change them. */
  columnsCommand(arg: string): void {
    if (arg.trim() === "reset") {
      this.sizes.forget();
      this.host.kernel.settings.setState("columns", this.sizes.kept());
      this.resized.value = this.resized.peek() + 1;
      this.host.screen.tell("column widths: config.json's again");
      return;
    }
    const cols = this.cols.peek();
    const widths = this.laidOut(cols);
    let fixed = 0;
    for (const w of widths) fixed += w;
    const named = this.host.screen.columns.map((c, i) => (c.id === "side" ? "files" : c.id) + " " + String(widths[i] > 0 ? widths[i] : cols - fixed));
    this.host.screen.tell(named.join(" · ") + " · drag a border to change one" + (this.sizes.any() ? ", /columns reset forgets the drags" : ""));
  }

  /** The shell's actions, each with its key: first, so a plugin's action on the same key comes before it. */
  private addKeys(): void {
    const h = this.host;
    const k = h.kernel.actions;
    const app = new Binder(k, "shell", "");
    app.add("app.interrupt", ["escape"], "interrupts", (_key: KeyEvent) => {
      if (!h.conversation.model.running) return false;
      h.conversation.interrupt();
      h.screen.tell("interrupt sent");
      return true;
    });
    // While the composer holds text, Ctrl+C and Ctrl+←/→ are its (clear, by a word): the shell's actions yield to the input scope, which comes after.
    const composing = (): boolean => {
      const c = h.screen.column(h.screen.active.peek());
      return c !== null && c.input !== null && !c.input.isEmpty();
    };
    app.add("app.quit", ["ctrl+char:c"], "", (_key: KeyEvent) => {
      if (composing()) return false;
      const now = Date.now();
      if (h.conversation.running && now - this.lastCtrlC > 2000) {
        this.lastCtrlC = now;
        h.conversation.interrupt();
        h.screen.tell("interrupted; Ctrl+C again to quit");
        return true;
      }
      h.quit();
      return true;
    });
    app.add("app.dump", ["f12"], "", (_key: KeyEvent) => {
      const fn = h.onDump;
      if (fn !== null) fn();
      return true;
    });
    for (let i = 0; i < FKEYS.length; i++) {
      const id = FKEY_COLUMNS[i];
      app.add("app.focus." + id, [FKEYS[i]], "", (_key: KeyEvent) => {
        h.screen.focus(id);
        return true;
      });
    }
    for (const spec of ["ctrl+left", "ctrl+right"]) {
      const step = spec === "ctrl+left" ? -1 : 1;
      app.add(step < 0 ? "app.column.previous" : "app.column.next", [spec], "", (_key: KeyEvent) => {
        if (composing()) return false;
        const n = h.screen.columns.length;
        if (n === 0) return true;
        let at = 0;
        for (let i = 0; i < n; i++) if (h.screen.columns[i].id === h.screen.active.peek()) at = i;
        h.screen.focus(h.screen.columns[(at + step + n) % n].id);
        return true;
      });
    }
    for (const spec of ["pageup", "pagedown"]) {
      const direction = spec === "pageup" ? -1 : 1;
      app.add(direction < 0 ? "app.page.up" : "app.page.down", [spec], "", (_key: KeyEvent) => {
        const c = h.screen.column(h.screen.active.peek());
        const panel = h.screen.shownPanel(h.screen.active.peek());
        const lines = panel !== null ? panel.view : c !== null ? c.lines : null;
        if (lines !== null) lines.page(direction);
        return true;
      });
    }
    for (const spec of TAB_COLUMNS) {
      const column = spec.id;
      new Binder(k, "shell", column).add(column + ".tab.next", ["tab"], "next tab", (_key: KeyEvent) => {
        const tabs = h.screen.panelsIn(column);
        const n = tabs.length;
        if (n === 0) return false;
        let at = 0;
        for (let i = 0; i < n; i++) if (tabs[i].id === h.screen.shownIn(column)) at = i;
        h.screen.showPanel(tabs[(at + 1) % n].id);
        return true;
      });
    }
  }

  /** Every command and key, as the keymap binds them, as a notice in the chat. */
  help(): void {
    const h = this.host;
    const k = h.kernel;
    const commands = k.commands.all().map((c) => c.name + (c.usage.length > 0 ? " " + c.usage : "") + " (" + c.help + ")");
    const label = (id: string): string => k.keys.label(id);
    const columns = label("app.focus.chat") + " chat, " + label("app.focus.side") + " files, " + label("app.focus.code") + " code, " + label("app.focus.tools") + " tools, or " + joinLabels([label("app.column.previous"), label("app.column.next")]) + " between columns, " + joinLabels([label("app.page.up"), label("app.page.down")]) + " (half a page), the wheel or a scrollbar scroll, " + label("app.quit") + " clears the message, and quits when it is empty (twice while " + h.conversation.agent.name() + " works)";
    // Each scope's hints, the composer's apart.
    const scopes: string[] = [];
    for (const a of k.actions.all()) if (a.scope !== "input" && !scopes.includes(a.scope)) scopes.push(a.scope);
    const hints: string[] = [];
    for (const scope of scopes) for (const hint of k.keys.hints(scope)) if (!hints.includes(hint)) hints.push(hint);
    const composer = k.keys.hints("input");
    const text =
      "Commands: " + commands.join(", ") + ". Keys: " + columns + ", " + hints.join(", ") + ". In the composer: " + composer.join(", ") + ". Keymap: " + h.keys.keymap + " (/keymap lists them; ~/.widecode/keys.json rebinds). A press on a \"· N tools\" line shows those calls in the Tools tab, on a call there shows it whole.";
    h.conversation.model.notice(text, "info", "", "");
    h.conversationChanged.fire();
  }

  /** /keymap: the one in use and the ones there are; `/keymap <name>` switches, kept for the next run. */
  keymapCommand(name: string): void {
    const h = this.host;
    const names = h.keys.names();
    if (name.length === 0) {
      h.screen.tell("keymap " + h.keys.keymap + " (" + names.join(", ") + "); /keymap <name> switches");
      return;
    }
    if (!names.includes(name)) {
      h.screen.tell("no keymap named " + name + " (" + names.join(", ") + ")");
      return;
    }
    h.keys.set(name);
    h.screen.tell("keymap " + name);
  }

  override render(): unknown {
    this.host.screen.layout.value;
    this.side();
    const cols = this.cols.value;
    const active = this.host.screen.active.value;
    this.host.screen.tabs.value;
    this.resized.value;
    const columns = this.host.screen.columns;
    const widths = this.laidOut(cols);
    // The band in parts as wide as the columns above them: each strip under the column it names.
    const last = columns.length > 0 ? columns[columns.length - 1].id : "";
    const under = (b: BandPart): string => (this.host.screen.column(b.under) !== null ? b.under : last);
    return html`<div flex=1 @copy=${(e: CustomEvent) => {
      const copy = e.detail;
      if (copy instanceof LineCopy) this.host.screen.copySelection(copy.text, copy.rows);
    }}>
      <div flex=1 direction="row">${columns.map((c, i) => {
        const tabs = this.tabs.get(c.id);
        const w = widths[i];
        return key(c.id, html`<wc-column title=${tabs !== undefined ? tabs.title() : c.title} ?active=${active === c.id} left=${c.left} right=${c.right} width=${w > 0 ? w : null} flex=${w > 0 ? 0 : 1} .view=${c.view} @mousedown=${(e: MouseEvent) => this.pressColumn(i, e)} @mousemove=${(e: MouseEvent) => this.dragBorder(e)} @mouseup=${(e: MouseEvent) => this.dropBorder(e)}></wc-column>`);
      })}</div>
      <div direction="row" bg=${palette.bandBg}>${columns.map((c, i) => {
        const w = widths[i];
        const parts = this.host.screen.band.filter((b) => under(b) === c.id);
        // Beside another strip, a tab column's links take the width they need.
        const links = this.links.get(c.id);
        return html`<div direction="row" width=${w > 0 ? w : null} flex=${w > 0 ? 0 : 1}>${parts.map((b) =>
          links !== undefined && b.view === links && parts.length > 1 ? html`<div width=${links.cells() + 1}>${b.view}</div>` : html`<div flex=1>${b.view}</div>`,
        )}</div>`;
      })}</div>
    </div>`;
  }
}
