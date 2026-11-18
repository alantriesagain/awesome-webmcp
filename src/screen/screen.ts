// The screen as the shell draws it and plugins share it: the active column, the message in the
// status bar, the tab each tab column shows, the registries (columns, side panels, band parts,
// status segments), the terminal's focus and the clipboard. What the shell renders is signals:
// `active` and `message` as they are, `tabs` and `layout` counters that move when a tab or the
// screen's parts come or go. One of light's controllers, as the app's state is.
import { type Signal, type TInput, signal } from "@lightstart/light/native/tui";
import { Controller } from "@lightstart/light/controller/class.ts";
import { Latest } from "@lightstart/lib/timing.ts";
import { Kernel } from "@lightstart/kernel/kernel.ts";
import { Clipboard } from "@lightstart/tui/clipboard.ts";
import { BandPart, Column, MenuEntry, Panel, Segments } from "./contributions.ts";

/** How long a message stays in the status bar before the key hints come back. */
const MESSAGE_MS = 8000;

/** Put the columns a saved order names first, in that order, in place: a saved id missing from `columns` is skipped, and the columns it does not name follow in their own order. */
export const applySavedOrder = (columns: Column[], saved: string[]): void => {
  let position = 0;
  for (const id of saved) {
    let at = -1;
    for (let i = 0; i < columns.length; i++) if (columns[i].id === id) { at = i; break; }
    if (at < 0) continue;
    const column = columns.splice(at, 1)[0];
    columns.splice(Math.min(position, columns.length), 0, column);
    position++;
  }
};

/** A saved order from state.json: its string ids, each once, in order. */
export const columnOrderOf = (value: unknown): string[] => {
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  for (const id of value as unknown[]) if (typeof id === "string" && !out.includes(id)) out.push(id);
  return out;
};

export class ScreenController extends Controller {
  readonly kernel: Kernel;
  /** The active column's id, the message in the status bar ("" for the key hints). */
  readonly active: Signal<string>;
  readonly message = signal("");
  /** Moves when the tab a tab column shows changes; when columns, tabs or band strips come or go (the shell lays out again). */
  readonly tabs = signal(0);
  readonly layout = signal(0);
  /** Moves when the menu bar's entries come or go. */
  readonly menus = signal(0);
  readonly columns: Column[] = [];
  readonly panels: Panel[] = [];
  readonly band: BandPart[] = [];
  readonly menuEntries: MenuEntry[] = [];
  readonly segments = new Segments();
  /** The system clipboard (does nothing until the entry configures it). */
  readonly clipboard = new Clipboard();
  /** Called with the input that takes the terminal's focus; with the named columns (every column for []) of the screen as drawn, set by what owns the renderer (null where nothing draws); with a line worth logging. */
  onFocusInput: ((input: TInput | null) => void) | null = null;
  onScreen: ((columns: string[]) => string) | null = null;
  onNote: ((text: string) => void) | null = null;
  /** The tab each tab column shows, by column id, and the columns whose tab was shown on purpose: until then the first tab (by order) is the one shown. */
  private readonly shown = new Map<string, string>();
  private readonly chosen = new Set<string>();
  private readonly messages = new Latest();
  /** The left-to-right order kept for the next run: where a column that comes back goes. */
  private savedOrder: string[] = [];

  /** `active` names the column active at start. */
  constructor(kernel: Kernel, active: string) {
    super("screen");
    this.kernel = kernel;
    this.active = signal(active);
  }

  /** The screen's parts changed: the shell lays out again on the next frame. */
  relayout(): void {
    this.layout.value = this.layout.peek() + 1;
  }

  private retab(): void {
    this.tabs.value = this.tabs.peek() + 1;
  }

  /** Add plugin `owner`'s column. */
  addColumn(owner: string, c: Column): void {
    c.owner = owner;
    for (let i = this.columns.length - 1; i >= 0; i--) if (this.columns[i].id === c.id) this.columns.splice(i, 1);
    this.columns.push(c);
    this.columns.sort((a, b) => a.order - b.order);
    applySavedOrder(this.columns, this.savedOrder);
    this.relayout();
  }

  /** The columns' ids left to right. */
  columnOrder(): string[] {
    return this.columns.map((c) => c.id);
  }

  /** Take the order a previous run kept: the columns there now follow it, and columns added later are placed by it. */
  setColumnOrder(ids: string[]): void {
    this.savedOrder = ids.slice();
    applySavedOrder(this.columns, this.savedOrder);
    this.relayout();
  }

  /** Move column `id` to `index` among the columns; false for an unknown id or a position it is already at. */
  moveColumn(id: string, index: number): boolean {
    let at = -1;
    for (let i = 0; i < this.columns.length; i++) if (this.columns[i].id === id) { at = i; break; }
    if (at < 0) return false;
    const to = Math.max(0, Math.min(this.columns.length - 1, Math.floor(index)));
    if (to === at) return false;
    const c = this.columns.splice(at, 1)[0];
    this.columns.splice(to, 0, c);
    this.savedOrder = this.columnOrder();
    this.relayout();
    return true;
  }

  /** Add plugin `owner`'s tab (to its column). */
  addPanel(owner: string, p: Panel): void {
    p.owner = owner;
    for (let i = this.panels.length - 1; i >= 0; i--) if (this.panels[i].id === p.id) this.panels.splice(i, 1);
    this.panels.push(p);
    this.panels.sort((a, b) => a.order - b.order);
    if (!this.chosen.has(p.column)) this.shown.set(p.column, this.panelsIn(p.column)[0].id);
    this.retab();
    this.relayout();
  }

  /** Add plugin `owner`'s strip of the band. */
  addBand(owner: string, b: BandPart): void {
    b.owner = owner;
    for (let i = this.band.length - 1; i >= 0; i--) if (this.band[i].id === b.id) this.band.splice(i, 1);
    this.band.push(b);
    this.band.sort((a, b2) => a.order - b2.order);
    this.relayout();
  }

  /** Add plugin `owner`'s menu bar entry. */
  addMenuEntry(owner: string, entry: MenuEntry): void {
    entry.owner = owner;
    this.menuEntries.push(entry);
    this.menuEntries.sort((a, b) => a.order - b.order);
    this.menus.value = this.menus.peek() + 1;
  }

  /** Drop everything plugin `owner` put on the screen: columns, tabs, band parts, menu entries, segments. */
  removeOwner(owner: string): void {
    for (let i = this.columns.length - 1; i >= 0; i--) if (this.columns[i].owner === owner) this.columns.splice(i, 1);
    for (let i = this.panels.length - 1; i >= 0; i--) if (this.panels[i].owner === owner) this.panels.splice(i, 1);
    for (let i = this.band.length - 1; i >= 0; i--) if (this.band[i].owner === owner) this.band.splice(i, 1);
    for (let i = this.menuEntries.length - 1; i >= 0; i--) if (this.menuEntries[i].owner === owner) this.menuEntries.splice(i, 1);
    this.menus.value = this.menus.peek() + 1;
    this.segments.removeOwner(owner);
    for (const id of Array.from(this.chosen)) if (this.column(id) === null && this.panelsIn(id).length === 0) this.chosen.delete(id);
    for (const column of Array.from(this.shown.keys())) {
      const p = this.findPanel(this.shown.get(column) ?? "");
      if (p !== null && p.column === column) continue;
      const left = this.panelsIn(column);
      if (left.length > 0) this.shown.set(column, left[0].id);
      else this.shown.delete(column);
    }
    this.retab();
    if (this.column(this.active.peek()) === null && this.columns.length > 0) this.focus(this.columns[0].id);
    this.relayout();
  }

  column(id: string): Column | null {
    for (const c of this.columns) if (c.id === id) return c;
    return null;
  }

  findPanel(id: string): Panel | null {
    for (const p of this.panels) if (p.id === id) return p;
    return null;
  }

  /** Tab column `column`'s tabs, left to right. */
  panelsIn(column: string): Panel[] {
    return this.panels.filter((p) => p.column === column);
  }

  /** The tab tab column `column` shows (its first until one is shown on purpose); null for none. */
  shownPanel(column: string): Panel | null {
    this.tabs.value;
    const p = this.findPanel(this.shown.get(column) ?? "");
    if (p !== null && p.column === column) return p;
    const all = this.panelsIn(column);
    return all.length > 0 ? all[0] : null;
  }

  /** The id of the tab `column` shows, "" for none. */
  shownIn(column: string): string {
    const p = this.shownPanel(column);
    return p !== null ? p.id : "";
  }

  /** The tabs the tab columns show, to put back with `setShown` (a reload). */
  shownTabs(): string[] {
    return Array.from(this.shown.values());
  }

  /** Make tab `id` the one its column shows, without going there. */
  setShown(id: string): void {
    const p = this.findPanel(id);
    if (p === null) return;
    this.chosen.add(p.column);
    this.shown.set(p.column, id);
    this.retab();
  }

  /** The key scopes in effect, most specific first: the shown tab of a tab column, the column, anywhere, and last the input the column holds (the composer's editing). */
  scopes(): string[] {
    const active = this.active.peek();
    const tab = this.shownIn(active);
    const out = tab.length > 0 ? [tab, active, ""] : [active, ""];
    const c = this.column(active);
    if (c !== null && c.input !== null) out.push("input");
    return out;
  }

  /** The key hints of the scopes in effect, for the status bar (the composer's editing left out: /help lists it). */
  hints(): string {
    const out: string[] = [];
    for (const scope of this.scopes()) {
      if (scope === "input") continue;
      for (const h of this.kernel.keys.hints(scope)) if (!out.includes(h)) out.push(h);
    }
    return out.join(" · ");
  }

  /** What the status bar's message cell shows: the latest message, else the hints. */
  noteText(): string {
    const m = this.message.value;
    this.active.value;
    this.tabs.value;
    return m.length > 0 ? m : this.hints();
  }

  /** A selection's text to the clipboard, saying how much went. */
  copySelection(text: string, rows: number): void {
    if (this.copy(text).length === 0) this.tell("copied " + (rows > 1 ? String(rows) + " lines" : String(text.length) + (text.length === 1 ? " character" : " characters")));
  }

  /** Put `text` on the clipboard; "" when it went, else why not (said in the status bar too). */
  copy(text: string): string {
    const error = this.clipboard.copy(text);
    if (error.length > 0) this.tell("cannot copy: " + error);
    return error;
  }

  /** Show `text` in the status bar for a while (and in the log); the same text already shown is noted again without changing the message. */
  tell(text: string): void {
    const ticket = this.messages.next();
    this.message.value = text;
    this.note(text);
    setTimeout(() => {
      if (!this.messages.is(ticket)) return;
      this.message.value = "";
    }, MESSAGE_MS);
  }

  /** Make column `id` active (and its input the terminal's focus). */
  focus(id: string): void {
    if (this.column(id) === null && this.panelsIn(id).length === 0) return;
    this.active.value = id;
    this.messages.cancel();
    this.message.value = "";
    const c = this.column(id);
    const fn = this.onFocusInput;
    if (fn !== null) fn(c !== null ? c.input : null);
  }

  /** Show tab `id` and make its column active. */
  showPanel(id: string): void {
    const p = this.findPanel(id);
    if (p === null) return;
    const before = this.shownPanel(p.column);
    this.setShown(id);
    if (before !== null && before !== p) before.hidden();
    p.shown();
    this.focus(p.column);
  }

  private note(text: string): void {
    const fn = this.onNote;
    if (fn !== null) fn(text);
  }
}
