// The chat column: the transcript over the composer, with the completion strip and the walk
// through the folder's earlier messages.
// The transcript's lines come from the model's turns, each rendered and cached by revision, with
// a "load earlier" line on top while older history is left in the file. At the bottom, while Claude
// is busy, a line says what it is doing, for how long this step (a call, the thinking) and the turn
// (its spinner and clocks move four times a second), then the messages still queued; a message sent
// while Claude is idle shows as sent at once, before the CLI takes it up. A press on a turn's
// "· N tools" line shows those calls in the Tools tab; on thinking or a notice, opens or closes it.
// The strip (suggest.ts) follows the composer: a path after "@", a command's name after "/", the
// values its argument takes after its name (Enter runs it with the one chosen). ↑ on the composer's
// first line walks back through the folder's messages (the ones the agent gave back first), ↓ on
// its last line forward and past the newest to the draft. A typed line goes to the chat role.
import { palette } from "@lightstart/tui/palette.ts";
import { clock } from "@lightstart/tui/duration.ts";
import { spinnerAt } from "@lightstart/light/native/tui/ticks.ts";
import { activityOf, stepOf } from "../conversation/activity.ts";
import { ChatModel, Item } from "../conversation/model.ts";
import { ChatHost } from "./host.ts";
import { Command, Suggestion } from "@lightstart/kernel/commands.ts";
import { Composer } from "./composer.ts";
import { RequestPanel } from "./request-panel.ts";
import { atToken, matchPaths, SuggestStrip } from "./suggest.ts";
import { CallGroup, PromptImages, chipAt, promptLines, turnLines } from "../conversation/render.ts";
import { Line, LinePress, LineView } from "@lightstart/tui/line-view.ts";
import { ModelSource } from "../conversation/model-source.ts";
import { type CustomEvent, type ChangeEvent, type SubmitEvent, TInput, View, graphemes, html, insertText, setValue, signal } from "@lightstart/light/native/tui";
import { clipText } from "@lightstart/tui/text.ts";

/** What the strip lists: paths for an @token, commands' names, a command's argument's values. */
const PATHS = 1;
const NAMES = 2;
const VALUES = 3;

/** The tag of the "load earlier" line. */
export class EarlierMarker {}
const EARLIER = new EarlierMarker();

export class ChatSource extends ModelSource {
  readonly host: ChatHost;
  private starts: number[] = [];
  private head: Line[] = [];
  private tail: Line[] = [];
  private total = 0;
  /** The line saying what Claude is doing (-1 while it is idle), and since when it has been busy (0: idle). */
  private activityAt = -1;
  private since = 0;

  constructor(host: ChatHost) {
    super(host);
    this.host = host;
  }

  protected rebuild(model: ChatModel, width: number): void {
    const conversation = this.host.current();
    this.head = [];
    if (model.earlier) {
      const l = new Line();
      l.add("↑ load earlier messages (press here or Home)", palette.link);
      l.tag = EARLIER;
      this.head.push(l);
      this.head.push(new Line());
    }
    if (model.turns.length === 0 && model.pending.length === 0) {
      const l = new Line();
      l.add(conversation.title.length > 0 ? "Resuming “" + conversation.title + "”. Write to continue." : "A new session in this folder. Write a message; /resume lists earlier sessions, /help the rest.", palette.dim);
      this.head.push(l);
    }
    this.starts = [];
    let total = this.head.length;
    for (const t of model.turns) {
      this.starts.push(total);
      total += turnLines(t, this.ctx, width).length;
    }
    this.tail = [];
    let queued = model.pending;
    // Sent while Claude is idle: the CLI takes it up next, so it shows as sent.
    if (!model.running && queued.length > 0) {
      const first = queued[0];
      for (const l of promptLines(first.text, width)) this.tail.push(l);
      if (first.images > 0) {
        const images = new Line();
        images.add("  " + (first.images === 1 ? "[1 image]" : "[" + String(first.images) + " images]"), palette.dim);
        this.tail.push(images);
      }
      this.tail.push(new Line());
      queued = queued.slice(1);
    }
    this.activityAt = this.busy() && model.openRequests().length === 0 ? total + this.tail.length : -1;
    if (this.activityAt >= 0) this.tail.push(new Line());
    for (const p of queued) {
      const l = new Line();
      l.add("⧗ queued: ", palette.warn);
      l.add(clipText(p.text.replace(/\s+/g, " "), Math.max(8, width - 12)), palette.dim);
      this.tail.push(l);
    }
    if (queued.length > 0) {
      const hint = new Line();
      hint.add("  ↑ in an empty composer takes " + (queued.length === 1 ? "it" : "them") + " back to edit", palette.dim);
      this.tail.push(hint);
    }
    this.total = total + this.tail.length;
  }

  override count(): number {
    return this.total;
  }

  /** The activity line and what is queued under it change on their own. */
  override liveFrom(): number {
    return this.activityAt >= 0 ? this.activityAt : this.total;
  }

  /** Whether Claude is busy (a message on its way, a turn running, a compaction); keeps since when. */
  busy(): boolean {
    const m = this.host.current().model;
    const busy = m.running || m.pending.length > 0 || m.status === "compacting";
    if (!busy) this.since = 0;
    else if (this.since === 0) this.since = Date.now();
    return busy;
  }

  /** What Claude is doing, its spinner and its clock, built as it is drawn. */
  private activity(width: number): Line {
    const conversation = this.host.current();
    const m = conversation.model;
    const now = Date.now();
    const a = activityOf(m);
    let what = "Working…";
    if (a === "compacting") what = "Compacting the conversation…";
    else if (!m.running) what = conversation.starting ? "Starting " + conversation.agent.name() + "…" : "Sending…";
    else if (a === "thinking") what = "Thinking…";
    else if (a === "writing") what = "Writing…";
    else if (a.length > 0 && a !== "working") what = "Running " + a;
    const l = new Line();
    l.add(spinnerAt(now) + " ", palette.think);
    l.add(clipText(what, Math.max(8, width - 40)), palette.think).italic = true;
    // This step's clock, then the turn's.
    const step = stepOf(m);
    if (step !== null && step.startedAt > 0) l.add(" " + clock(now - step.startedAt), palette.think);
    l.add((step !== null && step.startedAt > 0 ? " · turn " : " ") + clock(now - this.since) + (m.running ? " · Esc interrupts" : ""), palette.dim);
    return l;
  }

  override line(index: number, width: number): Line {
    if (index === this.activityAt) return this.activity(width);
    if (index < this.head.length) return this.head[index];
    const turnsEnd = this.total - this.tail.length;
    if (index >= turnsEnd) return this.tail[index - turnsEnd];
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    const lines = turnLines(this.host.current().model.turns[lo], this.ctx, width);
    const at = index - this.starts[lo];
    return at < lines.length ? lines[at] : new Line();
  }
}

export class ChatPane extends View {
  readonly host: ChatHost;
  readonly view = new LineView();
  readonly input = new TInput("textarea");
  /** The input's editing as actions, undo, the last kill. */
  readonly composer = new Composer(this.input);
  readonly panel: RequestPanel;
  /** The composer's border title ("You"; a keymap's mode indicator). */
  readonly label = signal("You");
  readonly strip = new SuggestStrip();
  readonly source: ChatSource;
  /** How far back ↑ has gone in the folder's messages (-1: at the draft), the draft kept meanwhile, and a recall in progress. */
  private back = -1;
  private draft = "";
  private recalling = false;
  /** The model whose given-back messages the composer took, and how many times it took them. */
  private withdrawnFrom: ChatModel;
  private withdrawnSeen = 0;
  /** What the strip lists now (PATHS, NAMES, VALUES), and the command whose values it lists. */
  private listing = 0;
  private command: Command | null = null;

  constructor(host: ChatHost) {
    super();
    this.box.flex = 1;
    this.host = host;
    this.panel = new RequestPanel(host);
    this.withdrawnFrom = host.current().model;
    this.source = new ChatSource(host);
    this.view.show(this.source, true);
    this.input.placeholder = this.placeholder();
    this.input.minLines = 1;
    this.input.maxLines = 8;
  }

  /** The composer's hint while it is empty, naming the agent. */
  private placeholder(): string {
    return "Write to " + this.host.current().agent.name() + ". Enter sends, Alt+Enter adds a line, Esc interrupts.";
  }

  /** The conversation changed: the hint names the agent it has now, and the transcript is drawn again (a reset or a resume replaced the model, whose version the view had followed). */
  refresh(): void {
    const hint = this.placeholder();
    if (this.input.placeholder !== hint) this.input.placeholder = hint;
    this.view.refresh();
  }

  /** Show the conversation from its end (it was replaced, resumed or reset). */
  showChat(): void {
    this.source.invalidate();
    this.view.setSource(this.source);
    this.view.follow = true;
    this.view.refresh();
  }

  /** Load earlier history, keeping the lines in view where they were. */
  loadEarlier(): void {
    const before = this.source.count();
    if (!this.host.current().loadEarlier()) return;
    this.source.invalidate();
    this.source.prepare(this.view.cols);
    this.view.follow = false;
    this.view.top += Math.max(0, this.source.count() - before);
    this.view.refresh();
  }

  private pressed(e: CustomEvent): void {
    const press = e.detail;
    if (press instanceof LinePress) this.press(press.index, press.column);
  }

  private press(index: number, column: number): void {
    const line = this.view.lineAt(index);
    if (line === null) return;
    const tag = line.tag;
    if (tag instanceof EarlierMarker) {
      this.loadEarlier();
      return;
    }
    if (tag instanceof CallGroup) {
      this.host.tools().reveal(tag.first);
      return;
    }
    if (tag instanceof PromptImages) {
      this.openImage(line, column, tag.paths);
      return;
    }
    if (tag instanceof Item) this.toggle(tag);
  }

  /** A press at `column` on a prompt line: open the image whose "[Image #N]" chip it lands on. */
  private openImage(line: Line, column: number, paths: string[]): void {
    const n = chipAt(line, column);
    const path = n > 0 ? paths[n - 1] : undefined;
    if (path !== undefined) this.host.openPath(path);
  }

  private toggle(item: Item): void {
    const why = this.host.current().toggle(item);
    if (why.length > 0) this.host.screen().tell(why);
  }

  /** The composer's text changed: completion follows it; typing over a recalled message makes it the draft, and a recalled one is not completed. */
  private changed(): void {
    if (this.recalling) {
      this.strip.hide();
      return;
    }
    this.back = -1;
    this.complete();
  }

  /** The walk through the folder's messages ends (a line was sent): the next ↑ starts from the newest. */
  leaveHistory(): void {
    this.back = -1;
    this.draft = "";
  }

  /** Put `text` in the composer, the caret at its end, without ending the walk. */
  private recall(text: string): void {
    this.recalling = true;
    setValue(this.input, text);
    this.recalling = false;
  }

  /** ↑: back through the folder's messages (the queued ones the agent gives back come first, while the composer is empty); false when the key is the composer's. */
  historyBack(): boolean {
    const input = this.input;
    const h = this.host;
    if (this.panel.active || this.strip.visible || input.row > 0) return false;
    if (h.current().model.pending.length > 0 && this.back === -1 && input.value().trim().length === 0) {
      const why = h.current().withdraw();
      if (why.length > 0) h.screen().tell(why);
      return true;
    }
    const older = h.history().at(this.back + 1);
    if (older === null) return true;
    if (this.back === -1) this.draft = input.value();
    this.back++;
    this.recall(older);
    return true;
  }

  /** ↓: forward through the folder's messages and past the newest to the draft; false when the key is the composer's. */
  historyForward(): boolean {
    const input = this.input;
    if (this.panel.active || this.strip.visible || this.back < 0 || input.row < input.lines.length - 1) return false;
    this.back--;
    this.recall(this.back < 0 ? this.draft : (this.host.history().at(this.back) ?? ""));
    return true;
  }

  /** Messages the agent gave back since the last look: into the composer, before what it holds. */
  takeWithdrawn(): void {
    const m = this.host.current().model;
    if (m !== this.withdrawnFrom) {
      this.withdrawnFrom = m;
      this.withdrawnSeen = m.withdrawnRev;
      return;
    }
    if (m.withdrawnRev === this.withdrawnSeen) return;
    this.withdrawnSeen = m.withdrawnRev;
    if (m.withdrawn.length === 0) {
      this.host.screen().tell("the queued messages were taken up already");
      return;
    }
    const now = this.input.value();
    this.recall(m.withdrawn.join("\n") + (now.trim().length > 0 ? "\n" + now : ""));
    this.host.screen().focus("chat");
  }

  /** Follow the composer: a command's name or its argument's values while one is typed on a line of its own, else paths for an @token. */
  complete(): void {
    const input = this.input;
    const strip = this.strip;
    const commands = this.host.kernel().commands;
    const text = input.lines.length === 1 ? (input.lines[0] ?? "") : "";
    this.listing = 0;
    this.command = null;
    if (text.startsWith("/")) {
      const space = text.indexOf(" ");
      let found: Suggestion[] = [];
      if (space < 0) {
        for (const c of commands.all()) if (c.name.startsWith(text)) found.push(new Suggestion(c.name, c.name + (c.usage.length > 0 ? " " + c.usage : ""), c.help));
        this.listing = NAMES;
      } else {
        const c = commands.find(text.slice(0, space));
        const fn = c !== null ? c.onComplete : null;
        if (c !== null && fn !== null) found = fn(text.slice(space + 1));
        this.command = c;
        this.listing = VALUES;
      }
      // Nothing to choose, or only what is typed already: the line is as it will run.
      const typed = space < 0 ? text : text.slice(space + 1).trim();
      if (found.length === 0 || (found.length === 1 && found[0].value === typed)) strip.hide();
      else strip.show(found, "↑↓ choose · Enter " + (this.listing === NAMES ? "takes it" : "runs it") + " · Tab fills it in");
      return;
    }
    const tok = atToken(input.lines[input.row] ?? "", input.col);
    if (tok === null) {
      strip.hide();
      return;
    }
    this.listing = PATHS;
    strip.show(matchPaths(this.host.paths(), tok.query, 6).map((p: string) => new Suggestion(p, "@" + p, "")), "Tab takes it, ↑↓ choose");
  }

  /** Tab while the strip shows: the highlighted suggestion goes in, a command's name (and a space when it takes an argument), its value after the name, a path for the @token. False while it does not show. */
  acceptSuggestion(): boolean {
    const strip = this.strip;
    if (!strip.visible) return false;
    const chosen = strip.current();
    const input = this.input;
    strip.hide();
    if (chosen === null) return true;
    if (this.listing === NAMES) {
      const c = this.host.kernel().commands.find(chosen.value);
      setValue(input, chosen.value + (c !== null && (c.onComplete !== null || c.usage.length > 0) ? " " : ""));
      return true;
    }
    if (this.listing === VALUES) {
      const c = this.command;
      if (c !== null) setValue(input, c.name + " " + chosen.value);
      return true;
    }
    const line = input.lines[input.row] ?? "";
    const tok = atToken(line, input.col);
    if (tok === null) return true;
    const gs = graphemes(line);
    input.lines[input.row] = gs.slice(0, tok.start).join("") + gs.slice(input.col).join("");
    input.col = tok.start;
    insertText(input, "@" + chosen.value + " ");
    strip.hide();
    return true;
  }

  /** Enter while the strip shows a command's name or value: the command runs with it (a command that takes an argument waits for one); false on paths, while a question is open, or while it does not show. */
  runSuggestion(): boolean {
    if (!this.strip.visible || this.listing === PATHS || this.panel.active) return false;
    const listing = this.listing;
    const command = listing === NAMES ? this.host.kernel().commands.find(this.strip.current()?.value ?? "") : null;
    this.acceptSuggestion();
    if (listing === NAMES && command !== null && (command.onComplete !== null || command.usage.length > 0)) return true;
    const text = this.input.value().trim();
    setValue(this.input, "");
    this.strip.hide();
    if (text.length > 0) this.host.chat().typed(text);
    return true;
  }

  /** ↑↓ while the strip shows move the highlight; false while it does not show. */
  moveSuggestion(delta: number): boolean {
    if (!this.strip.visible) return false;
    this.strip.move(delta);
    return true;
  }

  /** Esc while the strip shows hides it; false while it does not show. */
  hideSuggestions(): boolean {
    if (!this.strip.visible) return false;
    this.strip.hide();
    return true;
  }

  override render(): unknown {
    return html`<div flex=1 @press=${(e: CustomEvent) => this.pressed(e)}>
      ${this.view}
      ${this.strip}
      ${this.panel}
      <div border title=${this.label.value} fg=${palette.activeBorder} @submit=${(e: SubmitEvent) => {
        const text = this.composer.expand(e.value.trim());
        if (text.length > 0) this.host.chat().typed(text);
      }} @change=${(_e: ChangeEvent) => this.changed()}><div direction="row"><div width=1></div><div flex=1>${this.input}</div></div></div>
    </div>`;
  }
}
