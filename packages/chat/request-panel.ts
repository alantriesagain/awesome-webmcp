// The panel above the composer while the agent waits on the user: a request's questions, every
// one listed in a strip under the title and one shown at a time (↑↓ or a number choose, Space
// marks options of a multi-select, Enter answers, or the user's own words typed in the composer;
// ← and → move between the questions, an answered one showing its answer, which answering again
// replaces), or a plan (approve, or keep planning with the composer's text as feedback). The set
// is sent once every question has an answer; Esc declines it. The finished reply goes to
// the conversation, and the agent's adapter writes it as its agent expects (conversation/requests.ts).
import { palette } from "@light/ui/palette.ts";
import { Item, PLAN } from "@widecode/conversation/model.ts";
import { ChatHost } from "./host.ts";
import { Answer, Question, Reply } from "@widecode/conversation/requests.ts";
import { type KeyEvent, type MouseEvent, TemplateResult, View, html } from "@bootstrapp/light/native/tui";

/** What the user has done on one question: the options marked (a multi-select) and the answer recorded, if any. */
export class Draft {
  marks = new Set<number>();
  answer: Answer | null = null;
}

export class RequestPanel extends View {
  readonly host: ChatHost;
  item: Item | null = null;
  questions: Question[] = [];
  /** The agent's name, as the panel says it ("Claude asks"). */
  agentName = "the agent";
  /** The question shown. */
  index = 0;
  /** The highlighted row. */
  cursor = 0;
  /** One per question, in the questions' order. */
  drafts: Draft[] = [];

  constructor(host: ChatHost) {
    super();
    this.host = host;
  }

  get active(): boolean {
    return this.item !== null;
  }

  private isPlan(): boolean {
    const item = this.item;
    return item !== null && item.category === PLAN;
  }

  open(item: Item): void {
    this.item = item;
    this.questions = item.questions;
    this.index = 0;
    this.cursor = 0;
    this.drafts = [];
    for (let i = 0; i < item.questions.length; i++) this.drafts.push(new Draft());
    this.$requestUpdate();
  }

  /** The draft of the question shown. */
  private draft(): Draft {
    const d = this.drafts[this.index];
    return d === undefined ? new Draft() : d;
  }

  /** The marks of the question shown. */
  get chosen(): Set<number> {
    return this.draft().marks;
  }

  /** The answers recorded so far, in the questions' order. */
  get answers(): Answer[] {
    const out: Answer[] = [];
    for (const d of this.drafts) if (d.answer !== null) out.push(d.answer);
    return out;
  }

  /** Show question `index`, the cursor on its answer when it has one. */
  private show(index: number): void {
    const n = this.questions.length;
    if (n === 0) return;
    this.index = ((index % n) + n) % n;
    this.cursor = 0;
    const q = this.questions[this.index];
    const a = this.draft().answer;
    if (a !== null && a.text.length === 0 && a.labels.length > 0) {
      const at = q.options.findIndex((o) => o.label === a.labels[0]);
      if (at >= 0) this.cursor = at;
    } else if (a !== null && a.text.length > 0) this.cursor = q.options.length;
    this.$requestUpdate();
  }

  close(): void {
    this.item = null;
    this.$requestUpdate();
  }

  /** The rows of the current step: options plus "your own words", or the plan's two choices. */
  private rowCount(): number {
    if (this.isPlan()) return 2;
    const q = this.questions[this.index];
    return q === undefined ? 0 : q.options.length + 1;
  }

  private finish(reply: Reply): void {
    const item = this.item;
    this.close();
    if (item === null) return;
    this.host.current().respond(item, reply);
    this.host.screen().tell(reply.state === "approved" ? "plan approved" : reply.state === "answered" ? "answer sent" : "declined");
  }

  /** A reply declining the request, saying why. */
  private declined(message: string): Reply {
    const r = new Reply("declined");
    r.message = message;
    return r;
  }

  private hint(text: string): void {
    this.host.screen().tell(text);
  }

  /** Record `answer` for the question shown and move to the next one without an answer, sending once every question has one. */
  private answer(answer: Answer): void {
    const item = this.item;
    if (item === null) return;
    this.draft().answer = answer;
    const n = this.questions.length;
    for (let step = 1; step <= n; step++) {
      const at = (this.index + step) % n;
      const d = this.drafts[at];
      if (d !== undefined && d.answer === null) {
        this.show(at);
        return;
      }
    }
    const r = new Reply("answered");
    r.answers = this.answers;
    this.finish(r);
  }

  /** Enter (or a press) on row `row`. */
  private choose(row: number): void {
    const item = this.item;
    if (item === null) return;
    if (this.isPlan()) {
      if (row === 0) this.finish(new Reply("approved"));
      else this.hint("Write what to change in the box below and press Enter.");
      return;
    }
    const q = this.questions[this.index];
    if (q === undefined) return;
    if (row >= q.options.length) {
      this.hint("Write your answer in the box below and press Enter.");
      return;
    }
    const a = new Answer(q.question, q.multi);
    if (q.multi) {
      const marks = this.chosen;
      if (marks.size === 0) marks.add(row);
      for (let i = 0; i < q.options.length; i++) if (marks.has(i)) a.labels.push(q.options[i].label);
    } else a.labels.push(q.options[row].label);
    this.answer(a);
  }

  /** The composer's text while the panel is open: a free answer, or feedback on the plan. */
  submitText(text: string): void {
    if (this.isPlan()) {
      this.finish(this.declined(text));
      return;
    }
    const q = this.questions[this.index];
    if (q === undefined) return;
    const a = new Answer(q.question, q.multi);
    a.text = text;
    this.answer(a);
  }

  /** Keys while the panel is open; answers whether it took the key. */
  key(e: KeyEvent, composerEmpty: boolean): boolean {
    const name = e.key;
    const rows = this.rowCount();
    if (name === "up" || name === "down") {
      this.cursor = (this.cursor + (name === "up" ? rows - 1 : 1)) % Math.max(1, rows);
      this.$requestUpdate();
      return true;
    }
    if (name === "escape") {
      this.finish(this.declined(this.isPlan() ? "The user stopped here; wait for their next message." : "The user dismissed the question."));
      return true;
    }
    if (!composerEmpty) return false;
    if ((name === "left" || name === "right") && !this.isPlan() && this.questions.length > 1) {
      this.show(this.index + (name === "left" ? -1 : 1));
      return true;
    }
    if (name === "enter") {
      this.choose(this.cursor);
      return true;
    }
    if (e.typed(" ") && !this.isPlan()) {
      const q = this.questions[this.index];
      if (q !== undefined && q.multi && this.cursor < q.options.length) {
        const marks = this.chosen;
        if (marks.has(this.cursor)) marks.delete(this.cursor);
        else marks.add(this.cursor);
        this.$requestUpdate();
        return true;
      }
    }
    const digit = e.typedText();
    if (digit.length === 1 && digit >= "1" && digit <= "9") {
      const row = digit.charCodeAt(0) - 49;
      if (row < rows) {
        this.cursor = row;
        this.choose(row);
        return true;
      }
    }
    return false;
  }

  private press(e: MouseEvent, row: number): void {
    if (e.button !== 0) return;
    this.cursor = row;
    const q = this.questions[this.index];
    if (q !== undefined && q.multi && row < q.options.length) {
      const marks = this.chosen;
      if (marks.has(row)) marks.delete(row);
      else marks.add(row);
      this.$requestUpdate();
      return;
    }
    this.choose(row);
  }

  /** The strip naming every question of the set: the one shown highlighted, an answered one ticked. */
  private strip(): TemplateResult {
    const parts: TemplateResult[] = [];
    for (let i = 0; i < this.questions.length; i++) {
      const q = this.questions[i];
      const d = this.drafts[i];
      const on = i === this.index;
      const name = (d !== undefined && d.answer !== null ? "✓ " : "") + (q.header.length > 0 ? q.header : "Question " + String(i + 1));
      parts.push(html`<span fg=${on ? palette.warn : palette.dim} bold=${on} @mousedown=${(e: MouseEvent) => { if (e.button === 0) this.show(i); }}>${(i > 0 ? "  " : "") + name}</span>`);
    }
    return html`<p wrap="none">${parts}</p>`;
  }

  private row(index: number, label: string, detail: string, mark: string): TemplateResult {
    const on = index === this.cursor;
    return html`<p wrap="none" bg=${on ? palette.selectedBg : "default"} @mousedown=${(e: MouseEvent) => this.press(e, index)}><span fg=${on ? palette.warn : palette.dim}>${(on ? "› " : "  ") + String(index + 1) + ". " + mark}</span><span bold=${on}>${label}</span><span fg=${palette.dim}>${detail.length > 0 ? "  " + detail : ""}</span></p>`;
  }

  override render(): unknown {
    const item = this.item;
    if (item === null) return html``;
    if (this.isPlan())
      return html`<div border title="Plan ready" fg=${palette.warn}><div fg=${palette.paneText}>
        <p>${item.text.length > 0 ? "The plan is above. Start working on it?" : this.agentName + " finished planning. Start working on it?"}</p>
        ${this.row(0, "Yes, start", "leaves plan mode", "")}
        ${this.row(1, "No, keep planning", "write what to change below, Enter sends it", "")}
        <p fg=${palette.dim}>↑↓ or 1–2 choose · Enter · Esc stops here</p>
      </div></div>`;
    const q = this.questions[this.index];
    if (q === undefined) return html``;
    const several = this.questions.length > 1;
    const a = this.draft().answer;
    const chosenLabel = a !== null && a.text.length === 0 && !q.multi && a.labels.length > 0 ? a.labels[0] : "";
    const rows: TemplateResult[] = [];
    for (let i = 0; i < q.options.length; i++) rows.push(this.row(i, q.options[i].label, q.options[i].description, q.multi ? (this.chosen.has(i) ? "[x] " : "[ ] ") : q.options[i].label === chosenLabel ? "✓ " : ""));
    rows.push(this.row(q.options.length, "Something else", a !== null && a.text.length > 0 ? "answered: " + a.text : "type it below, Enter sends it", ""));
    const title = this.agentName + " asks" + (several ? " (" + String(this.index + 1) + "/" + String(this.questions.length) + ")" : "") + (q.header.length > 0 ? " · " + q.header : "");
    const keys = (q.multi ? "↑↓ move · Space marks · Enter answers" : "↑↓ or a number chooses · Enter answers") + (several ? " · ←→ other questions" : "") + " · Esc declines";
    return html`<div border title=${title} fg=${palette.warn}><div fg=${palette.paneText}>
      ${several ? this.strip() : html``}
      <p bold>${q.question}</p>
      ${rows}
      <p fg=${palette.dim}>${keys}</p>
    </div></div>`;
  }
}
