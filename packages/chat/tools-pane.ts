// The Tools tab of the tools column: Claude's tool calls, in the order it made them, under the
// message each answers (› its first line). A call is one row: where it stands (a spinner while it
// runs, then ● done, failed or stopped), its tool and what it was given, and how long it took, the
// clock moving while it runs. ↑↓ select, Enter or a press shows the call whole in the code column
// (a subagent's call, its steps); the chat's "· N tools" line shows its calls here. The list follows
// new calls until it is scrolled up. It plays the host's tools role once a plugin mounts it.
import { Panel } from "@widecode/screen/contributions.ts";
import { Run } from "@bootstrapp/light/native/tui/lines.ts";
import { palette } from "@light/ui/palette.ts";
import { span } from "@light/ui/duration.ts";
import { spinnerAt } from "@bootstrapp/light/native/tui/ticks.ts";
import { callMs, callState, DONE, FAILED, RUNNING } from "@widecode/conversation/calls.ts";
import { ChatModel, Item, PROMPT, TOOL } from "@widecode/conversation/model.ts";
import { toolSummary } from "@widecode/conversation/render.ts";
import { ChatHost } from "./host.ts";
import { ModelSource } from "@widecode/conversation/model-source.ts";
import { Line } from "@bootstrapp/light/native/tui/lines.ts";
import { stringWidth } from "@bootstrapp/light/native/tui";
import { clipText } from "@light/ui/text.ts";


/** A row of the list: a message's header, a call, or the gap between two turns. */
const HEAD = 0;
export const CALL = 1;
export const GAP = 2;

class Row {
  readonly kind: number;
  /** The call (CALL), the prompt (HEAD; null for a turn Claude started). */
  readonly item: Item | null;

  constructor(kind: number, item: Item | null) {
    this.kind = kind;
    this.item = item;
  }
}

/** The rows: per turn with calls, its message, then its calls (a message sent meanwhile between them). */
export class ToolsSource extends ModelSource {
  readonly host: ChatHost;
  rows: Row[] = [];
  /** The selected row (a call's), -1 for none. */
  selected = -1;

  constructor(host: ChatHost) {
    super(host);
    this.host = host;
  }

  protected rebuild(model: ChatModel, _width: number): void {
    const chosen = this.selected >= 0 && this.selected < this.rows.length ? this.rows[this.selected].item : null;
    const rows: Row[] = [];
    for (const t of model.turns) {
      const calls = t.body.children.filter((i: Item) => i.kind === TOOL);
      if (calls.length === 0) continue;
      if (rows.length > 0) rows.push(new Row(GAP, null));
      rows.push(new Row(HEAD, t.prompt));
      for (const item of t.body.children) {
        if (item.kind === TOOL) rows.push(new Row(CALL, item));
        else if (item.kind === PROMPT) rows.push(new Row(HEAD, item));
      }
    }
    this.rows = rows;
    // The selection stays on its call.
    this.selected = chosen !== null ? this.rowOf(chosen.id) : -1;
  }

  /** The row of call `id`, -1 when it is not listed. */
  rowOf(id: string): number {
    for (let i = 0; i < this.rows.length; i++) {
      const item = this.rows[i].item;
      if (this.rows[i].kind === CALL && item !== null && item.id === id) return i;
    }
    return -1;
  }

  override count(): number {
    return this.rows.length;
  }

  /** The first row whose call is running (its spinner and clock move, and the rows under it), or the count. */
  override liveFrom(): number {
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r.kind === CALL && r.item !== null && callState(r.item) === RUNNING) return i;
    }
    return this.rows.length;
  }

  override line(index: number, width: number): Line {
    const l = new Line();
    const row = index < this.rows.length ? this.rows[index] : null;
    if (row === null || row.kind === GAP) return l;
    const item = row.item;
    if (row.kind === HEAD) {
      // A message, a background task's notification (◇), or a turn Claude started.
      const text = item !== null ? item.text.replace(/\s+/g, " ").trim() : "";
      const own = item !== null && item.tone !== "notice";
      l.add(own ? " › " : " ◇ ", own ? palette.promptFg : palette.dim);
      l.decor = 1;
      l.add(clipText(text.length > 0 ? text : item !== null ? "(no text)" : this.ctx.agent + " continued on its own", Math.max(4, width - 4)), own ? palette.promptFg : palette.dim).italic = item === null;
      return l;
    }
    if (item === null) return l;
    const now = Date.now();
    const state = callState(item);
    const ms = callMs(item, now);
    const time = ms >= 0 ? span(ms) : "";
    const mark = state === RUNNING ? spinnerAt(now) : "●";
    l.add("   " + mark + " ", state === RUNNING ? palette.warn : state === DONE ? palette.ok : state === FAILED ? palette.bad : palette.dim);
    l.decor = 1;
    const name = item.name;
    l.add(name, "").bold = true;
    const room = width - 5 - stringWidth(name) - (time.length > 0 ? time.length + 2 : 0);
    const summary = toolSummary(item, this.ctx).replace(/\s+/g, " ").trim();
    // The programs the command ran, after what it does, when the row has room for both.
    const tag = item.programs.length > 0 ? " · " + item.programs.join(", ") : "";
    const fits = tag.length > 0 && room > stringWidth(summary) + stringWidth(tag) + 2;
    const shown = room > 2 && summary.length > 0 ? " " + clipText(summary, room - 1 - (fits ? stringWidth(tag) : 0)) : "";
    l.add(shown, palette.dim);
    if (fits) l.add(tag, palette.dim).italic = true;
    if (time.length > 0) {
      const used = 5 + stringWidth(name) + stringWidth(shown) + (fits ? stringWidth(tag) : 0);
      l.add(" ".repeat(Math.max(1, width - used - time.length)) + time, state === RUNNING ? palette.warn : palette.dim);
    }
    if (index === this.selected) {
      l.bg = palette.selectedBg;
      for (const r of l.runs) r.bg = palette.selectedBg;
    }
    l.tag = item;
    return l;
  }
}

/** The tab: its rows, info row, link badge and width. */
export class ToolsPanel extends Panel {
  readonly host: ChatHost;
  readonly source: ToolsSource;

  constructor(host: ChatHost, title: string, order: number) {
    super("calls", title, order);
    this.host = host;
    this.column = "tools";
    this.source = new ToolsSource(host);
    this.view.show(this.source, true);
  }

  /** Select row `at` and bring it into view (`center`: into the upper third). */
  select(at: number, center: boolean): void {
    this.source.selected = at;
    this.view.reveal(at, center);
    this.view.refresh();
  }

  /** How many calls, running, failed. */
  private counts(): number[] {
    let all = 0;
    let running = 0;
    let failed = 0;
    for (const r of this.source.rows) {
      if (r.kind !== CALL || r.item === null) continue;
      all++;
      const state = callState(r.item);
      if (state === RUNNING) running++;
      else if (state === FAILED) failed++;
    }
    return [all, running, failed];
  }

  override info(): Run[] {
    this.version.value;
    this.source.prepare(this.view.cols);
    const [all, running, failed] = this.counts();
    const out = [new Run(" " + String(all) + (all === 1 ? " call" : " calls"), palette.dim)];
    if (running > 0) out.push(new Run(" · " + String(running) + " running", palette.warn));
    if (failed > 0) out.push(new Run(" · " + String(failed) + " failed", palette.bad));
    return out;
  }

  override badge(): Run[] {
    this.version.value;
    this.source.prepare(this.view.cols);
    const [all, running] = this.counts();
    if (running > 0) return [new Run(String(running), palette.warn)];
    return all > 0 ? [new Run(String(all), palette.dim)] : [];
  }

  override width(cols: number): number {
    return Math.max(32, Math.min(44, Math.floor(cols / 7)));
  }

  /** A press on row `index` selects its call and shows it in the code column. */
  override press(index: number, _column: number): void {
    const row = index >= 0 && index < this.source.rows.length ? this.source.rows[index] : null;
    if (row === null || row.kind !== CALL || row.item === null) return;
    this.select(index, false);
    this.host.code().openCall(row.item.id);
  }
}
