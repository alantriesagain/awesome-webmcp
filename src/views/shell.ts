// The screen: the columns plugins registered, left to right (among them the tab columns, the files
// column and the tools column beside the chat, while plugins registered tabs for them:
// tab-column.ts), and the status band under them. Keys go to the kernel's bindings in the scopes in
// effect (a tab column's shown tab, the active column, anywhere), and the active column's input has
// the terminal's focus. The shell's own keys: Ctrl+C (interrupt the agent, then quit), F12 (the
// screen's text to the log), F1 (chat), F2 (files), F3 (code), F6 (tools), F10 (the menu bar) and
// Ctrl+←/→ between the columns, PgUp/PgDn (half a page), Esc (interrupt the agent), Tab through a
// tab column's tabs; /help, written from
// every command and key binding registered, and /columns. The columns are as wide as column-widths.ts
// says; a drag on the border between two resizes them, and state.json keeps what it left.
import type { Host } from "../host/host.ts";
import type { KeymapController } from "../host/keymaps.ts";
import type { ScreenController } from "../screen/screen.ts";
import type { Kernel } from "@lightstart/kernel/kernel.ts";
import hostController from "../controllers/host.ts";
import kernelController from "../controllers/kernel.ts";
import keymapController from "../controllers/keymap.ts";
import screenController from "../controllers/screen.ts";
import sessionController from "../controllers/session.ts";
import type { SessionController } from "../host/session.ts";
import type { Conversation } from "../conversation/conversation.ts";
import { BandPart, Column } from "../screen/contributions.ts";
import { columnOrderOf } from "../screen/screen.ts";
import { Action, Binder } from "@lightstart/kernel/actions.ts";
import { joinLabels } from "@lightstart/kernel/keys.ts";
import { type CustomEvent, KeyEvent, type MouseEvent, TBox, TElement, TNode, View, html, signal, key, tabAt } from "@lightstart/light/native/tui";
import { LineCopy } from "@lightstart/tui/line-view.ts";
import { Menu, MenuBar, MenuItem } from "@lightstart/tui/menu-bar.ts";
import { ColumnWidths } from "./column-widths.ts";
import { TabColumn } from "./tab-column.ts";
import "../screen/column-view.ts";
import { palette } from "@lightstart/tui/palette.ts";
import { logPath, trail } from "@lightstart/lib/log.ts";
import { Command, Suggestion } from "@lightstart/kernel/commands.ts";
import { welcome } from "./onboarding.ts";

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

/** A column being dragged: its id, where the press was, and whether the pointer moved. */
class ColumnDrag {
  readonly id: string;
  readonly from: number;
  moved = false;

  constructor(id: string, from: number) {
    this.id = id;
    this.from = from;
  }
}

/** The column each function key makes active. */
const FKEYS = ["f1", "f2", "f3", "f6"];
const FKEY_COLUMNS = ["chat", "side", "code", "tools"];

export class Shell extends View {
  readonly menuBar = new MenuBar();
  /** The tab columns (by id: "side", "tools"). */
  readonly tabs = new Map<string, TabColumn>();
  private readonly cols = signal(160);
  private lastCtrlC = 0;
  /** The columns' widths: config.json's, a drag's; `resized` moves when a drag changes one. */
  readonly sizes = new ColumnWidths();
  private readonly resized = signal(0);
  private readonly keymapVersion = signal(0);
  /** The menu entries, the keymap and the actions last built into the bar. */
  private menuSignature = "";
  private drag: BorderDrag | null = null;
  private columnDrag: ColumnDrag | null = null;
  /** The column the dragged column would drop on (drawn on the drop color in the dragged one's accent). */
  private readonly dropTarget = signal("");
  /** The border the pointer is over or drags, as the column left of it (-1 for none). */
  private readonly edge = signal(-1);

  constructor() {
    super();
    this.box.flex = 1;
    this.menuBar.brand.value = "◆ widecode";
    this.keys.changed.add("shell", () => {
      this.keymapVersion.value = this.keymapVersion.peek() + 1;
    });
    for (const spec of TAB_COLUMNS) {
      this.tabs.set(spec.id, new TabColumn(spec.id));
    }
    this.addKeys();
  }

  /** The start's Host, for what crosses its parts: the roles, quitting, a dump, a plugin's removal. */
  get host(): Host {
    return hostController.current;
  }

  /** The start's screen, kernel and keymaps. */
  private get screen(): ScreenController {
    return screenController.current;
  }

  private get kernel(): Kernel {
    return kernelController.current;
  }

  private get keys(): KeymapController {
    return keymapController.current;
  }

  /** The start's session, and its conversation with the agent. */
  private get session(): SessionController {
    return sessionController.current;
  }

  private get conversation(): Conversation {
    return sessionController.current.conversation;
  }

  /** Once the plugins started: the /help hint last, the tab columns that have tabs, the widths a drag left, and the shell's commands. */
  finish(): void {
    this.kernel.actions.add(new Action("app.help", "", "/help", [], "shell", (_key: KeyEvent, _count: number) => false));
    this.side();
    this.screen.setColumnOrder(columnOrderOf(this.kernel.settings.state("columnOrder")));
    this.sizes.restore(this.kernel.settings.state("columns"));
    this.addCommands();
  }

  /** The shell's commands: the help, the welcome, the keymap, the columns, the log's path. */
  private addCommands(): void {
    const commands = this.kernel.commands;
    commands.add(new Command("/help", "", "this list", "shell", (_arg: string) => this.help()));
    commands.add(new Command("/welcome", "", "the welcome: the columns, the keys and commands to start with", "shell", (_arg: string) => welcome(this.host)));
    const keymap = new Command("/keymap", "[name]", "the keymap in use: default, or one a plugin brings (emacs, vi); kept for the next run", "shell", (arg: string) => this.keymapCommand(arg.trim()));
    keymap.onComplete = (arg: string): Suggestion[] => this.keys.names().filter((n) => n.startsWith(arg.trim())).map((n) => new Suggestion(n, n, n === this.keys.keymap ? "now" : ""));
    commands.add(keymap);
    commands.add(new Command("/columns", "[reset]", "the columns' widths; reset forgets the widths borders were dragged to", "shell", (arg: string) => this.columnsCommand(arg)));
    commands.add(
      new Command("/log", "", "where this run's log goes (config.json's \"log\" turns it off or moves it)", "shell", (_arg: string) => {
        const p = logPath();
        this.screen.tell(p.length > 0 ? "log: " + p : "the log is off (config.json's \"log\", or --log <path>)");
      }),
    );
  }

  /** The tab columns, each added while plugins registered tabs for it and dropped when none are left. */
  side(): void {
    for (const spec of TAB_COLUMNS) {
      const tabs = this.tabs.get(spec.id);
      if (tabs === undefined) continue;
      // Owned per column.
      const owner = "shell:" + spec.id;
      const has = this.screen.column(spec.id) !== null;
      if (this.screen.panelsIn(spec.id).length === 0) {
        if (has) this.host.removeOwner(owner);
        continue;
      }
      if (has) continue;
      // As wide as the shown panel asks; its tabs go on its top edge.
      this.screen.addColumn(owner, new Column(spec.id, spec.title, spec.order, tabs, (cols: number) => {
        const p = tabs.current();
        return p !== null ? p.width(cols) : 24;
      }, 0, 0, null, null));
    }
  }

  resize(cols: number): void {
    this.cols.value = cols;
  }

  /** A key from the terminal: true when an action took it. The composer's text before it goes on its undo stack when the key changed it. */
  handleKey(e: KeyEvent): boolean {
    trail.reset();
    const d = trail.enter("key", keyName(e));
    if (this.menuBar.key(e)) {
      trail.leave(d);
      return true;
    }
    const composer = this.host.roles.chat.composer;
    const before = composer !== null ? composer.snapshot() : null;
    const id = this.kernel.keys.dispatch(e, this.screen.scopes());
    if (composer !== null && before !== null) composer.record(before, id);
    trail.leave(d);
    return id.length > 0;
  }

  /** The columns' widths at `cols` terminal columns, in their order (0 for the one taking the rest). */
  private laidOut(cols: number): number[] {
    const columns = this.screen.columns;
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
    const at = this.screen.columns.findIndex((c) => c.id === id);
    return at >= 0 ? this.widths()[at] : -1;
  }

  /** Where column `id` starts: the widths of the columns left of it (-1 for none). */
  xOf(id: string): number {
    const widths = this.widths();
    let x = 0;
    for (let i = 0; i < this.screen.columns.length; i++) {
      if (this.screen.columns[i].id === id) return x;
      x += widths[i];
    }
    return -1;
  }

  /** The columns' widths as drawn, the one taking the rest as wide as the others leave. */
  private shownWidths(): number[] {
    const cols = this.cols.peek();
    const widths = this.laidOut(cols);
    let fixed = 0;
    for (const w of widths) fixed += w;
    return widths.map((w) => (w > 0 ? w : Math.max(0, cols - fixed)));
  }

  /** The column under `x`, and whether `x` is in its left half (drop before it). */
  private targetAt(x: number): { index: number; before: boolean } | null {
    const columns = this.screen.columns;
    if (columns.length === 0) return null;
    const shown = this.shownWidths();
    let start = 0;
    for (let i = 0; i < columns.length; i++) {
      const w = shown[i];
      if (x < start + w || i === columns.length - 1) return { index: i, before: x < start + w / 2 };
      start += w;
    }
    return null;
  }

  /** The cell-bordered box of column `index` (the div inside its wc-column element), for where its top edge is. */
  private columnBox(index: number): TBox | null {
    const columns: TBox[] = [];
    this.collectColumns(this.box, columns);
    if (index < 0 || index >= columns.length) return null;
    return this.borderBox(columns[index]);
  }

  /** The wc-column elements under `node`, in document order. */
  private collectColumns(node: TNode, out: TBox[]): void {
    if (!(node instanceof TElement)) return;
    if (node instanceof TBox && node.tag === "wc-column") out.push(node);
    for (let c = node.firstChild; c !== null; c = c.next) this.collectColumns(c, out);
  }

  /** The first cell-bordered box under `node`, where a column's tabs are drawn. */
  private borderBox(node: TNode): TBox | null {
    if (!(node instanceof TBox)) return null;
    if (node.border) return node;
    for (let c = node.firstChild; c !== null; c = c.next) {
      const found = this.borderBox(c);
      if (found !== null) return found;
    }
    return null;
  }

  /** A left press on column `index`: on its border with a neighbour, a drag starts resizing them; on its title row, a drag starts moving it (and a tab column shows the tab under it); else the column becomes active. */
  /** The border column `index`'s cell at `x` is on, as the column left of it (-1 when `x` is on none that resizes). */
  private borderAt(index: number, x: number): number {
    const cols = this.cols.peek();
    const widths = this.laidOut(cols);
    const shown = this.shownWidths();
    let start = 0;
    for (let i = 0; i < index; i++) start += shown[i];
    const columns = this.screen.columns;
    // The border between columns a and b: the one with a width of its own changes (the code column takes the rest).
    let a = -1;
    if (x === start + shown[index] - 1 && index < columns.length - 1) a = index;
    else if (x === start && index > 0) a = index - 1;
    if (a < 0) return -1;
    return widths[widths[a] > 0 ? a : a + 1] > 0 ? a : -1;
  }

  /** The pointer over a border that resizes: the two columns draw their sides along it, so the handle shows. */
  private hoverColumn(index: number, e: MouseEvent): void {
    e.consume();
    if (this.drag === null) this.edge.value = this.borderAt(index, e.x);
  }

  private pressColumn(index: number, e: MouseEvent): void {
    if (e.button !== 0) return;
    this.columnDrag = null;
    const widths = this.laidOut(this.cols.peek());
    const shown = this.shownWidths();
    const columns = this.screen.columns;
    const a = this.borderAt(index, e.x);
    if (a >= 0) {
      const left = widths[a] > 0;
      const target = left ? a : a + 1;
      this.edge.value = a;
      this.drag = new BorderDrag(columns[target].id, e.x, shown[target], left ? 1 : -1);
      return;
    }
    const box = this.columnBox(index);
    if (box !== null && e.y === box.y) {
      if (this.tabs.get(columns[index].id) !== undefined) {
        const at = tabAt(box, e.x);
        const panels = this.screen.panelsIn(columns[index].id);
        if (at >= 0 && at < panels.length) this.screen.showPanel(panels[at].id);
      }
      this.columnDrag = new ColumnDrag(columns[index].id, e.x);
    }
    const id = columns[index].id;
    if (this.screen.active.peek() !== id) this.screen.focus(id);
  }

  /** The column under the pointer follows it: the drop target's border lights, and the status bar says where it would land. */
  private dragColumn(e: MouseEvent): void {
    const d = this.columnDrag;
    if (d === null) return;
    if (e.x !== d.from) d.moved = true;
    const target = this.targetAt(e.x);
    if (target === null) return;
    const columns = this.screen.columns;
    const c = columns[target.index];
    if (c.id === d.id) {
      this.dropTarget.value = "";
      this.screen.tell("");
      return;
    }
    this.dropTarget.value = c.id;
    let dragged = c;
    for (const column of columns) if (column.id === d.id) dragged = column;
    this.screen.tell("move " + dragged.title + (target.before ? " before " : " after ") + c.title);
  }

  /** Let go: the column takes the place the target showed, kept in state.json for the next run. */
  private dropColumn(e: MouseEvent): void {
    const d = this.columnDrag;
    if (d === null) return;
    this.columnDrag = null;
    const target = this.targetAt(e.x);
    this.dropTarget.value = "";
    this.screen.tell("");
    if (!d.moved || target === null) return;
    const columns = this.screen.columns;
    if (columns[target.index].id === d.id) return;
    let from = -1;
    for (let i = 0; i < columns.length; i++) if (columns[i].id === d.id) { from = i; break; }
    if (from < 0) return;
    const i = target.index;
    const index = target.before ? (from > i ? i : i - 1) : from > i ? i + 1 : i;
    if (this.screen.moveColumn(d.id, index)) this.kernel.settings.setState("columnOrder", this.screen.columnOrder());
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
    this.kernel.settings.setState("columns", this.sizes.kept());
  }

  /** The columns' widths now, and how to change them. */
  columnsCommand(arg: string): void {
    if (arg.trim() === "reset") {
      this.sizes.forget();
      this.kernel.settings.setState("columns", this.sizes.kept());
      this.resized.value = this.resized.peek() + 1;
      this.screen.tell("column widths: config.json's again");
      return;
    }
    const cols = this.cols.peek();
    const widths = this.laidOut(cols);
    let fixed = 0;
    for (const w of widths) fixed += w;
    const named = this.screen.columns.map((c, i) => (c.id === "side" ? "files" : c.id) + " " + String(widths[i] > 0 ? widths[i] : cols - fixed));
    this.screen.tell(named.join(" · ") + " · drag a border to change one" + (this.sizes.any() ? ", /columns reset forgets the drags" : ""));
  }

  /** The shell's actions, each with its key: first, so a plugin's action on the same key comes before it. */
  private addKeys(): void {
    const k = this.kernel.actions;
    const app = new Binder(k, "shell", "");
    app.add("app.interrupt", ["escape"], "interrupts", (_key: KeyEvent) => {
      if (!this.conversation.model.running) return false;
      this.conversation.interrupt();
      this.screen.tell("interrupt sent");
      return true;
    });
    // While the composer holds text, Ctrl+C and Ctrl+←/→ are its (clear, by a word): the shell's actions yield to the input scope, which comes after.
    const composing = (): boolean => {
      const c = this.screen.column(this.screen.active.peek());
      return c !== null && c.input !== null && !c.input.isEmpty();
    };
    app.add("app.quit", ["ctrl+char:c"], "", (_key: KeyEvent) => {
      if (composing()) return false;
      const now = Date.now();
      if (this.conversation.running && now - this.lastCtrlC > 2000) {
        this.lastCtrlC = now;
        this.conversation.interrupt();
        this.screen.tell("interrupted; Ctrl+C again to quit");
        return true;
      }
      this.host.quit();
      return true;
    });
    app.add("app.dump", ["f12"], "", (_key: KeyEvent) => {
      const fn = this.host.onDump;
      if (fn !== null) fn();
      return true;
    });
    app.add("app.menu", ["f10"], "", (_key: KeyEvent) => {
      this.menuBar.open(0);
      return true;
    });
    for (let i = 0; i < FKEYS.length; i++) {
      const id = FKEY_COLUMNS[i];
      app.add("app.focus." + id, [FKEYS[i]], "", (_key: KeyEvent) => {
        this.screen.focus(id);
        return true;
      });
    }
    for (const spec of ["ctrl+left", "ctrl+right"]) {
      const step = spec === "ctrl+left" ? -1 : 1;
      app.add(step < 0 ? "app.column.previous" : "app.column.next", [spec], "", (_key: KeyEvent) => {
        if (composing()) return false;
        const n = this.screen.columns.length;
        if (n === 0) return true;
        let at = 0;
        for (let i = 0; i < n; i++) if (this.screen.columns[i].id === this.screen.active.peek()) at = i;
        this.screen.focus(this.screen.columns[(at + step + n) % n].id);
        return true;
      });
    }
    for (const spec of ["pageup", "pagedown"]) {
      const direction = spec === "pageup" ? -1 : 1;
      app.add(direction < 0 ? "app.page.up" : "app.page.down", [spec], "", (_key: KeyEvent) => {
        const c = this.screen.column(this.screen.active.peek());
        const panel = this.screen.shownPanel(this.screen.active.peek());
        const lines = panel !== null ? panel.view : c !== null ? c.lines : null;
        if (lines !== null) lines.page(direction);
        return true;
      });
    }
    for (const spec of TAB_COLUMNS) {
      const column = spec.id;
      new Binder(k, "shell", column).add(column + ".tab.next", ["tab"], "next tab", (_key: KeyEvent) => {
        const tabs = this.screen.panelsIn(column);
        const n = tabs.length;
        if (n === 0) return false;
        let at = 0;
        for (let i = 0; i < n; i++) if (tabs[i].id === this.screen.shownIn(column)) at = i;
        this.screen.showPanel(tabs[(at + 1) % n].id);
        return true;
      });
    }
  }

  /** Build the bar's menus from the entries, with each item's key as the keymap binds it now. */
  private buildMenus(): void {
    const entries = this.screen.menuEntries;
    const parts: string[] = [this.keys.keymap];
    for (const e of entries) parts.push(e.owner + "\n" + e.menu + "\n" + e.label + "\n" + e.action + "\n" + String(e.order) + "\n" + this.kernel.keys.label(e.action) + "\n" + String(this.kernel.actions.find(e.action) !== null));
    const signature = parts.join("\n");
    if (signature === this.menuSignature) return;
    this.menuSignature = signature;
    const titles: string[] = [];
    for (const e of entries) if (!titles.includes(e.menu)) titles.push(e.menu);
    const lowest = (title: string): number => {
      let order = 1e9;
      for (const e of entries) if (e.menu === title && e.order < order) order = e.order;
      return order;
    };
    titles.sort((a, b) => lowest(a) - lowest(b));
    const menus: Menu[] = [];
    for (const title of titles) {
      const items: MenuItem[] = [];
      for (const e of entries) {
        if (e.menu !== title) continue;
        if (e.label === "-") {
          items.push(MenuItem.separator());
          continue;
        }
        const item = new MenuItem(e.label, this.kernel.keys.label(e.action), () => this.runAction(e.action));
        item.enabled = this.kernel.actions.find(e.action) !== null;
        items.push(item);
      }
      menus.push(new Menu(title, items));
    }
    this.menuBar.setMenus(menus);
  }

  /** Run action `id` as its key would. */
  private runAction(id: string): void {
    const a = this.kernel.actions.find(id);
    if (a !== null) a.onRun(new KeyEvent("none", "", false, false, false), 1);
  }

  /** Every command and key, as the keymap binds them, as a notice in the chat. */
  help(): void {
    const k = this.kernel;
    const commands = k.commands.all().map((c) => c.name + (c.usage.length > 0 ? " " + c.usage : "") + " (" + c.help + ")");
    const label = (id: string): string => k.keys.label(id);
    const columns = label("app.focus.chat") + " chat, " + label("app.focus.side") + " files, " + label("app.focus.code") + " code, " + label("app.focus.tools") + " tools, or " + joinLabels([label("app.column.previous"), label("app.column.next")]) + " between columns, " + joinLabels([label("app.page.up"), label("app.page.down")]) + " (half a page), the wheel or a scrollbar scroll, " + label("app.quit") + " clears the message, and quits when it is empty (twice while " + this.conversation.agent.name() + " works)";
    // Each scope's hints, the composer's apart.
    const scopes: string[] = [];
    for (const a of k.actions.all()) if (a.scope !== "input" && !scopes.includes(a.scope)) scopes.push(a.scope);
    const hints: string[] = [];
    for (const scope of scopes) for (const hint of k.keys.hints(scope)) if (!hints.includes(hint)) hints.push(hint);
    const composer = k.keys.hints("input");
    const text =
      "Commands: " + commands.join(", ") + ". Keys: " + columns + ", " + hints.join(", ") + ". In the composer: " + composer.join(", ") + ". Keymap: " + this.keys.keymap + " (/keymap lists them; ~/.widecode/keys.json rebinds). A press on a \"· N tools\" line shows those calls in the Tools tab, on a call there shows it whole.";
    this.conversation.model.notice(text, "info", "", "");
    this.session.conversationChanged.fire();
  }

  /** /keymap: the one in use and the ones there are; `/keymap <name>` switches, kept for the next run. */
  keymapCommand(name: string): void {
    const names = this.keys.names();
    if (name.length === 0) {
      this.screen.tell("keymap " + this.keys.keymap + " (" + names.join(", ") + "); /keymap <name> switches");
      return;
    }
    if (!names.includes(name)) {
      this.screen.tell("no keymap named " + name + " (" + names.join(", ") + ")");
      return;
    }
    this.keys.set(name);
    this.screen.tell("keymap " + name);
  }

  override render(): unknown {
    this.screen.layout.value;
    this.screen.menus.value;
    this.keymapVersion.value;
    this.buildMenus();
    this.side();
    const cols = this.cols.value;
    const active = this.screen.active.value;
    this.screen.tabs.value;
    this.resized.value;
    const drop = this.dropTarget.value;
    const dragged = this.columnDrag;
    const columns = this.screen.columns;
    const widths = this.laidOut(cols);
    // The band in parts as wide as the columns above them: each strip under the column it names.
    const last = columns.length > 0 ? columns[columns.length - 1].id : "";
    const under = (b: BandPart): string => (this.screen.column(b.under) !== null ? b.under : last);
    const edge = this.edge.value;
    return html`<div flex=1 bg=${palette.screenBg} @mousehover=${() => {
      this.edge.value = -1;
    }} @copy=${(e: CustomEvent) => {
      const copy = e.detail;
      if (copy instanceof LineCopy) this.screen.copySelection(copy.text, copy.rows);
    }}>${this.menuBar}<div height=1></div>
      <div flex=1 direction="row">${columns.map((c, i) => {
        const tabs = this.tabs.get(c.id);
        const panels = tabs !== undefined ? this.screen.panelsIn(c.id) : [];
        // A tab's label is its title and its badge's text ("Todo 3").
        const labels = panels.map((p) => (p.title + " " + p.badge().map((r) => r.text).join("")).trim()).join("\n");
        const current = this.screen.shownIn(c.id);
        let shown = -1;
        for (let j = 0; j < panels.length; j++) if (panels[j].id === current) shown = j;
        const w = widths[i];
        return key(c.id, html`<wc-column column=${c.id} title=${c.title} tabs=${labels} shown=${shown} ?active=${active === c.id} drop=${drop === c.id && dragged !== null ? dragged.id : ""} edge=${edge === i ? "right" : edge === i - 1 && i > 0 ? "left" : ""} left=${c.left} right=${c.right} width=${w > 0 ? w : null} flex=${w > 0 ? 0 : 1} .view=${c.view} @mousedown=${(e: MouseEvent) => this.pressColumn(i, e)} @mousehover=${(e: MouseEvent) => this.hoverColumn(i, e)} @mousemove=${(e: MouseEvent) => {
          this.dragBorder(e);
          this.dragColumn(e);
        }} @mouseup=${(e: MouseEvent) => {
          this.dropBorder(e);
          this.dropColumn(e);
        }}></wc-column>`);
      })}</div>
      <div direction="row" bg=${palette.bandBg}>${columns.map((c, i) => {
        const w = widths[i];
        const parts = this.screen.band.filter((b) => under(b) === c.id);
        return html`<div direction="row" width=${w > 0 ? w : null} flex=${w > 0 ? 0 : 1}>${parts.map((b) =>
          html`<div flex=1>${b.view}</div>`,
        )}</div>`;
      })}</div>
    </div>`;
  }
}
