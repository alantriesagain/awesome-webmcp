// Completion in the composer: the `@token` being typed and the folder's paths that match it (a name
// that starts with it first, then one that contains it, then any path holding its letters in
// order), a command's name or its argument's values (commands/Command.onComplete), and the strip
// above the composer that lists them, the highlighted one taken with Tab (and Enter, for a
// command's).
import { palette } from "@light/ui/palette.ts";
import { Suggestion } from "@light/kernel/commands.ts";
import { View, graphemes, html, signal } from "@bootstrapp/light/native/tui";

export class AtToken {
  /** Grapheme index of the "@" in the line. */
  start: number;
  query: string;

  constructor(start: number, query: string) {
    this.start = start;
    this.query = query;
  }
}

/** The `@token` ending at the caret (`col` in graphemes), or null. */
export const atToken = (line: string, col: number): AtToken | null => {
  const gs = graphemes(line);
  let i = Math.min(col, gs.length) - 1;
  let query = "";
  while (i >= 0) {
    const g = gs[i];
    if (g === "@") {
      if (i > 0 && gs[i - 1] !== " ") return null;
      return new AtToken(i, query);
    }
    if (g === " " || g === "\t") return null;
    query = g + query;
    i--;
  }
  return null;
};

const subsequence = (text: string, query: string): boolean => {
  let at = 0;
  for (const ch of text) {
    if (at < query.length && ch === query.charAt(at)) at++;
  }
  return at === query.length;
};

class Scored {
  path: string;
  score: number;

  constructor(path: string, score: number) {
    this.path = path;
    this.score = score;
  }
}

/** Whether `a` comes before `b`: a better score, then a shorter path, then the path's order. */
const before = (a: Scored, b: Scored): boolean => (a.score !== b.score ? a.score > b.score : a.path.length !== b.path.length ? a.path.length < b.path.length : a.path < b.path);

/** Up to `max` paths matching `query`, best first, keeping only the best `max` as it walks. */
export const matchPaths = (paths: string[], query: string, max: number): string[] => {
  const q = query.toLowerCase();
  const best: Scored[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    let score = -1;
    if (q.length === 0) score = 1;
    else if (name.startsWith(q)) score = 4;
    else if (lower.startsWith(q)) score = 3;
    else if (lower.includes(q)) score = 2;
    else if (subsequence(lower, q)) score = 1;
    if (score < 0) continue;
    const item = new Scored(p, score);
    let at = 0;
    while (at < best.length && before(best[at], item)) at++;
    best.splice(at, 0, item);
    if (best.length > max) best.pop();
  }
  const out: string[] = [];
  for (const s of best) out.push(s.path);
  return out;
};

/** The most rows the strip shows (typing narrows the rest). */
const STRIP_ROWS = 8;

export class SuggestStrip extends View {
  readonly items = signal<Suggestion[]>([]);
  readonly selected = signal(0);
  /** How many more matched than it shows, and what its first row says to do. */
  readonly more = signal(0);
  readonly hint = signal("");

  get visible(): boolean {
    return this.items.peek().length > 0;
  }

  /** Show the first STRIP_ROWS of `items`, `hint` on the first. */
  show(items: Suggestion[], hint: string): void {
    this.items.value = items.slice(0, STRIP_ROWS);
    this.more.value = Math.max(0, items.length - STRIP_ROWS);
    this.hint.value = hint;
    if (this.selected.peek() >= this.items.peek().length) this.selected.value = 0;
  }

  hide(): void {
    if (this.items.peek().length > 0) this.items.value = [];
    this.selected.value = 0;
  }

  move(delta: number): void {
    const n = this.items.peek().length;
    if (n > 0) this.selected.value = (this.selected.peek() + delta + n) % n;
  }

  current(): Suggestion | null {
    const items = this.items.peek();
    const at = this.selected.peek();
    return at < items.length ? items[at] : null;
  }

  override render(): unknown {
    const items = this.items.value;
    const at = this.selected.value;
    const more = this.more.value;
    const hint = this.hint.value;
    if (items.length === 0) return html``;
    return html`<div>${items.map(
      (s, i) =>
        html`<p wrap="none" bg=${i === at ? palette.selectedBg : "default"}><span fg=${i === at ? palette.link : "default"}>${(i === at ? " › " : "   ") + s.label}</span>${s.detail.length > 0 ? html`<span fg=${palette.dim}>${"  " + s.detail}</span>` : ""}${i === 0 ? html`<span fg=${palette.dim}>${"   " + hint}</span>` : ""}</p>`,
    )}${more > 0 ? html`<p wrap="none"><span fg=${palette.dim}>${"   " + String(more) + " more: type to narrow"}</span></p>` : ""}</div>`;
  }
}
