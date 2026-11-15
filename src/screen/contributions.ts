// What plugins put on the screen through the screen controller. A Column is one of the bordered
// columns side by side; a Panel a tab of a tab column; a BandPart a strip of the status band under
// the columns; a SegmentDef a segment the status table can show (by its name in the app's config),
// drawn from a SegmentContext.
import { StatusInfo } from "../agent/status-info.ts";
import { LineView } from "@light/ui/line-view.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { TInput, View, signal } from "@lightstart/light/native/tui";
import { Keyed } from "@light/kernel/registry.ts";

export class Column {
  readonly id: string;
  readonly title: string;
  /** Left to right by order. */
  readonly order: number;
  readonly view: View;
  /** Its width at `cols` terminal columns; 0 takes what the others leave. */
  readonly widthAt: (cols: number) => number;
  /** Cells kept clear inside its border, left and right. */
  readonly left: number;
  readonly right: number;
  /** The input that takes the terminal's focus while the column is active (null: none). */
  readonly input: TInput | null;
  /** What PgUp and PgDn scroll (null: nothing). */
  readonly lines: LineView | null;
  /** The plugin that added it (set by the host). */
  owner = "";

  constructor(id: string, title: string, order: number, view: View, widthAt: (cols: number) => number, left: number, right: number, input: TInput | null, lines: LineView | null) {
    this.id = id;
    this.title = title;
    this.order = order;
    this.view = view;
    this.widthAt = widthAt;
    this.left = left;
    this.right = right;
    this.input = input;
    this.lines = lines;
  }
}

/** A tab of a tab column: its rows in a LineView, an info row under the tabs, its keys in its id's scope. */
export abstract class Panel {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly view = new LineView();
  /** Moves when the info row and the link's badge should draw again: `info()` and `badge()` read it, `touch()` moves it. */
  readonly version = signal(0);
  /** The plugin that added it (set by the host). */
  owner = "";
  /** The tab column it shows in: "side" (the files column) or "tools" (beside the chat). */
  column = "side";

  constructor(id: string, title: string, order: number) {
    this.id = id;
    this.title = title;
    this.order = order;
  }

  /** The info row and the badge draw again on the next frame. */
  touch(): void {
    this.version.value = this.version.peek() + 1;
  }

  /** The row under the tabs. */
  info(): Run[] {
    return [];
  }

  /** A press at column `x` of the info row. */
  infoPress(_x: number): void {}

  /** A press on row `index` of its rows, at `column` (the view's `press` event, or a test). */
  press(_index: number, _column: number): void {}

  /** Another tab of its column took its place. */
  hidden(): void {}

  /** Its column's width while this tab shows, at `cols` terminal columns. */
  width(cols: number): number {
    return Math.max(24, Math.min(30, Math.floor(cols / 10)));
  }

  /** The tab became the one shown. */
  shown(): void {}

  /** What its link on the band shows after the title (a count, ahead and behind); none by default. */
  badge(): Run[] {
    return [];
  }
}

/** A menu bar entry: its menu's title, its label ("-" for a separator), the action it runs and where it sits. */
export class MenuEntry {
  readonly menu: string;
  readonly label: string;
  readonly action: string;
  readonly order: number;
  /** The plugin that added it (set by the host). */
  owner = "";

  constructor(menu: string, label: string, action: string, order: number) {
    this.menu = menu;
    this.label = label;
    this.action = action;
    this.order = order;
  }
}

export class BandPart {
  readonly id: string;
  /** The column it sits under ("chat", "side", "code"), as wide as it; "" or a column that is not there: under the last one. */
  readonly under: string;
  readonly order: number;
  readonly view: View;
  /** The plugin that added it (set by the host). */
  owner = "";

  constructor(id: string, under: string, order: number, view: View) {
    this.id = id;
    this.under = under;
    this.order = order;
    this.view = view;
  }
}

/** What a status segment draws from: the session's StatusInfo and what the screen adds. */
export class SegmentContext {
  info = new StatusInfo();
  folderName = "";
  /** The latest message for the user, or key hints. */
  note = "";
  busy = false;
  spinner = "";
  now = 0;
}

/** A segment of the status table: its name in config.json, its runs, what a press on it does. */
export class SegmentDef {
  readonly name: string;
  readonly owner: string;
  /** Its runs now; [] when it has nothing to show. */
  readonly draw: (ctx: SegmentContext) => Run[];
  readonly onSegmentPress: (() => void) | null;

  constructor(name: string, owner: string, draw: (ctx: SegmentContext) => Run[], onSegmentPress: (() => void) | null) {
    this.name = name;
    this.owner = owner;
    this.draw = draw;
    this.onSegmentPress = onSegmentPress;
  }
}

/** The segments plugins registered, by name (a later one of a name replaces the earlier). */
export class Segments {
  private list = new Keyed<SegmentDef>();

  add(d: SegmentDef): void {
    this.list.put(d.name, d.owner, d);
  }

  find(name: string): SegmentDef | null {
    return this.list.get(name);
  }

  /** Drop every segment plugin `owner` added. */
  removeOwner(owner: string): void {
    this.list.removeOwner(owner);
  }

  names(): string[] {
    return this.list.names();
  }
}
