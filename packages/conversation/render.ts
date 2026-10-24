// Chat items as terminal lines. A turn: the prompt on a tinted band, then its items, then a
// footer with the time and cost. Text is Markdown; thinking that came with words is one dim line,
// its first one, that a press opens (thinking with no words, only a size, is not drawn: the chat's
// last line says while Claude thinks). In a turn, the calls Claude made between two of its other
// items are one line (`· 3 tools · Read ×2, Bash`, one call `· Bash npm test`) whose press shows
// them in the Tools tab. Drawn on
// its own (a subagent's steps in the code column), a tool call is one summary line (`● Edit
// src/a.ts  +3 -1`, a long command cut short) that a press expands into its input in full and its
// output (an Edit's or Write's change as a diff); a subagent's call holds its items, nested behind a
// bar; `callPage` draws one call whole. Lines are cached per item and per turn by revision and
// width, so a streaming delta re-renders only the block it changed.
import { palette } from "@light/ui/palette.ts";
import { stamp, took } from "@light/ui/duration.ts";
import { Line, Run } from "@bootstrapp/light/native/tui/lines.ts";
import { stringWidth } from "@bootstrapp/light/native/tui/width.ts";
import { callState, FAILED, RUNNING, STOPPED } from "./calls.ts";
import { clipText, expandTabs, wrap } from "@light/ui/text.ts";
import { renderMarkdown } from "@light/markdown/markdown.ts";
import { EDIT, Item, NOTICE, PLAN, PROMPT, QUESTION, REQUEST, TEXT, THINKING, TOOL, Turn } from "./model.ts";

/** How many lines of a tool's output an expanded card shows. */
const OUTPUT_LINES = 40;
/** A tool call's summary (a command, a pattern) is cut to this many cells on its line; a press shows it all. */
const SUMMARY_CELLS = 60;

/** Tool inputs and results, and their nested objects; every field `unknown`, read with str/num/list. */

export class RenderContext {
  /** The folder paths are shown relative to. */
  folder = "";
  /** The agent's name, as lines about it say it ("Claude asks"). */
  agent = "the agent";
  /** Whether a turn's prompt and reply carry their "[stamp] <who>: " label (a caller that wants the plain transcript turns it off). */
  stamps = true;
}

const line = (indent: Run[], text: string, fg: string): Line => {
  const l = new Line();
  l.decor = indent.length;
  for (const r of indent) l.runs.push(r);
  l.add(text, fg);
  return l;
};

const firstLine = (text: string): string => {
  const cut = text.indexOf("\n");
  return cut >= 0 ? text.slice(0, cut) + " …" : text;
};


/** The one-line description of a tool call: its adapter's, else its input while it streams. */
export const toolSummary = (item: Item, ctx: RenderContext): string => {
  void ctx;
  if (item.summary.length > 0) return item.summary;
  return item.input === null && item.partial.length > 0 ? clipText(item.partial.replace(/\s+/g, " "), 80) : "";
};

/** The tool's name on a call's line: none for a command, whose line says what it does, not which shell ran it. */
export const toolName = (item: Item): string => (item.command.length > 0 ? "" : item.name);

const statusMark = (item: Item): Run => {
  const state = callState(item);
  // ● and not ⏺: VTE terminals draw ⏺ as a two-cell emoji over the name after it.
  if (state === RUNNING) return new Run("● ", palette.warn);
  if (state === FAILED) return new Run("● ", palette.bad);
  if (state === STOPPED) return new Run("● ", palette.dim);
  return new Run("● ", palette.ok);
};

const pushAll = (out: Line[], lines: Line[]): void => {
  for (const l of lines) out.push(l);
};

const outputLines = (text: string, indent: Run[], width: number, fg: string, out: Line[], max: number): void => {
  const all = text.split("\n");
  const shown = all.length > max ? all.slice(0, max) : all;
  for (const t of shown) out.push(line(indent, clipText(expandTabs(t), Math.max(1, width - 6)), fg));
  if (all.length > max) out.push(line(indent, "… " + String(all.length - max) + " more lines", palette.dim));
};

const diffLines = (item: Item, indent: Run[], width: number, out: Line[], max: number): boolean => {
  const result = item.result;
  if (result === null) return false;
  const hunks = result.patch;
  let shown = 0;
  for (const hunk of hunks) {
    out.push(line(indent, "@@ " + String(hunk.oldStart) + " → " + String(hunk.newStart), palette.dim));
    for (const s of hunk.lines) {
      const kind = s.charAt(0);
      if (kind === "\\") continue;
      const row = line(indent, clipText(expandTabs(s), Math.max(1, width - 6)), kind === "+" ? palette.ok : kind === "-" ? palette.bad : "");
      if (kind === "+") row.bg = palette.addedBg;
      else if (kind === "-") row.bg = palette.removedBg;
      out.push(row);
      if (++shown >= max) {
        out.push(line(indent, "… more", palette.dim));
        return true;
      }
    }
  }
  return hunks.length > 0;
};

/** A call's input in full and its output: `max` lines of output (twice that of a change); on a page of its own (`page`), its input too when it says nothing else. */
const toolDetails = (item: Item, ctx: RenderContext, indent: Run[], width: number, out: Line[], max: number, page: boolean): void => {
  const bar = indent.concat([new Run("  ⎿ ", palette.dim)]);
  // The command whole, wrapped (its line shows it cut).
  if (item.command.length > 0)
    for (const part of item.command.split("\n")) pushAll(out, wrap([new Run(expandTabs(part), palette.code)], width, bar, indent.concat([new Run("    ", "")]), ""));
  if (item.category === EDIT && diffLines(item, bar, width, out, max * 2)) return;
  if (item.written.length > 0) {
    outputLines(item.written, bar, width, palette.ok, out, max);
    return;
  }
  if (item.todos.length > 0) {
    for (const t of item.todos) out.push(line(bar, (t.state === "done" ? "☒ " : t.state === "doing" ? "◐ " : "☐ ") + t.text, t.state === "done" ? palette.dim : ""));
    return;
  }
  if (page && item.command.length === 0 && item.input !== null) {
    outputLines(JSON.stringify(item.input, null, 2), bar, width, palette.code, out, max);
    out.push(new Line());
  }
  const result = item.result;
  if (result !== null && result.text.length > 0) outputLines(result.text, bar, width, result.isError ? palette.bad : palette.dim, out, max);
  else if (result === null && item.partial.length > 0) outputLines(item.partial, bar, width, palette.dim, out, max);
  void ctx;
};

/** A call's output and change, at most this many lines on its own page. */
const PAGE_LINES = 2000;

/** A tool call on a page of its own (the code column): its line, where it stands (`state`, e.g.
 * "done · 1.2s"), its input whole and its output, longer than its card. */
export const callPage = (item: Item, ctx: RenderContext, width: number, state: string): Line[] => {
  const out: Line[] = [];
  const head = new Line();
  head.runs.push(statusMark(item));
  head.decor = 1;
  const name = toolName(item);
  head.add(name, "").bold = true;
  const summary = toolSummary(item, ctx);
  if (summary.length > 0) head.add((name.length > 0 ? " " : "") + clipText(summary, Math.max(8, width - name.length - 4)), palette.dim);
  out.push(head);
  out.push(line([new Run("  ", "")], state, palette.dim));
  out.push(new Line());
  toolDetails(item, ctx, [], width, out, PAGE_LINES, true);
  return out;
};


/** One item's lines, cached by its revision, the width and its expansion; `label` (a turn's reply stamp) is drawn on the first line and is not cached. */
export const itemLines = (item: Item, ctx: RenderContext, indent: Run[], width: number, label?: Run[]): Line[] => {
  let key = "";
  for (const r of indent) key += r.text;
  if (label === undefined && item.cacheRev === item.rev && item.cacheWidth === width && item.cacheIndent === key) return item.cache;
  const out: Line[] = [];
  if (item.kind === TEXT) pushAll(out, renderMarkdown(item.text, width, indent, palette.messageFg, label ?? []));
  else if (item.kind === THINKING) {
    // Words only: a size alone says nothing worth a line.
    const words = item.text.trim();
    if (words.length > 0) {
      const l = line(indent.concat([new Run("✻ ", palette.dim)]), clipText(firstLine(words).replace(/\s+/g, " "), Math.max(8, width - 4)) + (item.done ? "" : "…"), palette.dim);
      l.runs[l.runs.length - 1].italic = true;
      l.tag = item;
      out.push(l);
      if (item.expanded) pushAll(out, renderMarkdown(words, width, indent.concat([new Run("  ", "")]), palette.dim));
    }
  } else if (item.kind === TOOL) {
    const head = new Line();
    for (const r of indent) head.runs.push(r);
    head.runs.push(statusMark(item));
    head.decor = head.runs.length;
    const name = toolName(item);
    head.add(name, "").bold = true;
    const summary = toolSummary(item, ctx);
    if (summary.length > 0) head.add((name.length > 0 ? " " : "") + clipText(summary, Math.max(8, Math.min(SUMMARY_CELLS, width - name.length - 6))), palette.dim);
    const task = item.task;
    if (task !== null && task.status === "running" && task.lastTool.length > 0) head.add("  · " + task.lastTool, palette.warn);
    if (item.children.length > 0 || item.result !== null || item.input !== null) head.add(item.expanded ? "  ▾" : "  ▸", palette.dim);
    head.tag = item;
    out.push(head);
    if (item.children.length > 0) {
      const nested = indent.concat([new Run("│ ", palette.dim)]);
      if (item.expanded) for (const child of item.children) pushAll(out, itemLines(child, ctx, nested, width));
      else if (task !== null && task.summary.length > 0) out.push(line(indent.concat([new Run("  ⎿ ", palette.dim)]), clipText(firstLine(task.summary), Math.max(8, width - 6)), palette.dim));
      else {
        const last = item.children[item.children.length - 1];
        const lines = itemLines(last, ctx, nested, width);
        if (lines.length > 0) out.push(lines[lines.length - 1]);
      }
    } else if (item.expanded) toolDetails(item, ctx, indent, width, out, OUTPUT_LINES, false);
  } else if (item.kind === PROMPT) {
    // A prompt from the agent itself (a background task's end): one line, not a message.
    if (item.tone === "notice") out.push(line(indent.concat([new Run("◇ ", palette.dim)]), clipText(item.text, Math.max(8, width - 4)), palette.dim));
    else pushAll(out, wrap([new Run(item.text, palette.promptFg)], width, indent.concat([new Run("› ", palette.promptFg)]), indent.concat([new Run("  ", "")]), ""));
  } else if (item.kind === NOTICE && item.tone === "aside") {
    // A side question (/btw) and its answer, apart from the conversation.
    pushAll(out, wrap([new Run(item.text, palette.promptFg)], width, indent.concat([new Run("btw ", palette.dim)]), indent.concat([new Run("    ", "")]), ""));
    const answer = item.detail.length > 0 ? item.detail : "…";
    pushAll(out, renderMarkdown(answer, width, indent.concat([new Run("  │ ", palette.dim)]), item.state === "failed" ? palette.bad : item.done ? "" : palette.dim));
    if (out.length > 0) out[0].tag = item;
  } else if (item.kind === NOTICE) {
    const fg = item.tone === "error" ? palette.bad : palette.dim;
    pushAll(out, wrap([new Run(item.text, fg)], width, indent.concat([new Run(item.tone === "command" ? "› " : "· ", fg)]), indent.concat([new Run("  ", "")]), ""));
    if (item.detail.length > 0 && (item.expanded || item.tone === "error")) pushAll(out, renderMarkdown(item.detail, width, indent.concat([new Run("  ", "")]), palette.dim));
    if (out.length > 0) out[0].tag = item;
  } else if (item.kind === REQUEST) {
    const l = line(indent, item.category === PLAN ? "◆ Plan ready for your approval" : "◆ " + ctx.agent + " asks", palette.warn);
    l.runs[l.runs.length - 1].bold = true;
    if (item.state !== "open") l.add("  " + (item.state === "cancelled" ? "withdrawn" : item.state), palette.dim);
    out.push(l);
    if (item.category === PLAN && item.text.length > 0) pushAll(out, renderMarkdown(item.text, width, indent.concat([new Run("│ ", palette.warn)]), ""));
    for (const q of item.questions) {
      pushAll(out, wrap([new Run(q.question, "")], width, indent.concat([new Run("  ", "")]), indent.concat([new Run("  ", "")]), ""));
      for (const o of q.options) pushAll(out, wrap([new Run(o.label + (o.description.length > 0 ? " · " + o.description : ""), palette.dim)], width, indent.concat([new Run("    • ", palette.dim)]), indent.concat([new Run("      ", "")]), ""));
    }
  }
  // A label for a line that is not text (the reply's first item was a call): prepend it as it stands.
  if (label !== undefined && item.kind !== TEXT && out.length > 0) out[0].runs = label.concat(out[0].runs);
  if (label === undefined) {
    item.cache = out;
    item.cacheRev = item.rev;
    item.cacheWidth = width;
    item.cacheIndent = key;
  }
  return out;
};


/** What a press on a turn's "· N tools" line acts on: the first of the calls it stands for. */
export class CallGroup {
  readonly first: string;

  constructor(first: string) {
    this.first = first;
  }
}

/** Calls made one after another, as one line: one call, its tool and what it was given; more, how many and their tools (Read ×2, Bash); how many run and failed. */
const groupLine = (calls: Item[], ctx: RenderContext, width: number): Line => {
  const names: string[] = [];
  const counts: number[] = [];
  let running = 0;
  let failed = 0;
  for (const c of calls) {
    const at = names.indexOf(c.name);
    if (at >= 0) counts[at]++;
    else {
      names.push(c.name);
      counts.push(1);
    }
    const state = callState(c);
    if (state === RUNNING) running++;
    else if (state === FAILED) failed++;
  }
  const l = new Line();
  l.add("· ", palette.dim);
  l.decor = 1;
  if (calls.length === 1) {
    const summary = toolSummary(calls[0], ctx).replace(/\s+/g, " ").trim();
    const name = toolName(calls[0]);
    l.add(name, palette.dim).bold = true;
    if (summary.length > 0) l.add((name.length > 0 ? " " : "") + clipText(summary, Math.max(8, Math.min(SUMMARY_CELLS, width - name.length - 24))), palette.dim);
  } else {
    l.add(String(calls.length) + " tools", palette.dim);
    const tools = names.map((n: string, i: number) => n + (counts[i] > 1 ? " ×" + String(counts[i]) : "")).join(", ");
    l.add(" · " + clipText(tools, Math.max(8, width - 32)), palette.dim);
  }
  if (running > 0) l.add(" · " + String(running) + " running", palette.warn);
  if (failed > 0) l.add(" · " + String(failed) + " failed", palette.bad);
  l.add("  ▸", palette.dim);
  l.tag = new CallGroup(calls[0].id);
  return l;
};

/** A prompt's text as runs: its words, and each "[Image #N]" a chip in the link color. */
const promptRuns = (text: string): Run[] => {
  const runs: Run[] = [];
  const chip = /\[Image #\d+\]/g;
  let at = 0;
  let m = chip.exec(text);
  while (m !== null) {
    if (m.index > at) runs.push(new Run(text.slice(at, m.index), palette.messageFg));
    runs.push(new Run(m[0], palette.link));
    at = m.index + m[0].length;
    m = chip.exec(text);
  }
  if (at < text.length) runs.push(new Run(text.slice(at), palette.messageFg));
  if (runs.length === 0) runs.push(new Run("(no text)", palette.messageFg));
  return runs;
};

/** The tag of a prompt's lines: the files their "[Image #N]" chips open. */
export class PromptImages {
  readonly paths: string[];

  constructor(paths: string[]) {
    this.paths = paths;
  }
}

/** The N of the "[Image #N]" chip a press at `column` on `line` lands on (0 for none). */
export const chipAt = (line: Line, column: number): number => {
  let at = 0;
  for (const run of line.runs) {
    const width = stringWidth(run.text);
    const chip = /^\[Image #(\d+)\]$/.exec(run.text);
    if (chip !== null && column >= at && column < at + width) return Number(chip[1]);
    at += width;
  }
  return 0;
};

/** A message's label: a dim "[stamp] " then the who, bold in its own color ("[12:13:00 12/03/2026] <Me>: "). */
const messageLabel = (ms: number, who: string): Run[] => {
  const at = new Run("[" + stamp(ms) + "] ", palette.dim);
  const name = new Run("<" + who + ">: ", palette.name);
  name.bold = true;
  return [at, name];
};

/** `runs` as spaces of the width they take, a wrapped line's continuation. */
const blank = (runs: Run[]): Run[] => [new Run(" ".repeat(runs.reduce((n, r) => n + stringWidth(r.text), 0)), "")];

/** A prompt's lines, as a turn starts with them: its "[stamp] <Me>: " label (or "› " without a time), its words, and one empty banded row below. */
export const promptLines = (text: string, width: number, at = 0): Line[] => {
  const lead = at > 0 ? messageLabel(at, "Me") : [new Run("› ", palette.promptFg)];
  const lines = wrap(promptRuns(text), width, lead, at > 0 ? blank(lead) : [new Run("  ", "")], palette.promptBg);
  // One more row, the same band: the message's own space (a stamped message only).
  if (at > 0) lines.push(new Line());
  // The band fills the whole row: a line sizes to its runs, so each run carries the background and the
  // row is padded out to the width with it.
  for (const l of lines) {
    l.bg = palette.promptBg;
    let used = 0;
    for (const r of l.runs) {
      r.bg = palette.promptBg;
      used += stringWidth(r.text);
    }
    if (used < width) l.add(" ".repeat(Math.max(0, width - used)), "").bg = palette.promptBg;
  }
  return lines;
};

export const turnLines = (turn: Turn, ctx: RenderContext, width: number): Line[] => {
  if (turn.cacheRev === turn.rev && turn.cacheWidth === width) return turn.cache;
  const out: Line[] = [];
  const prompt = turn.prompt;
  // A turn the agent's own prompt started (a background task's end): one line, not a message.
  if (prompt !== null && prompt.tone === "notice") out.push(line([new Run("◇ ", palette.dim)], clipText(prompt.text, Math.max(8, width - 4)), palette.dim));
  else if (prompt !== null) {
    const lines = promptLines(prompt.text, width, ctx.stamps ? turn.at : 0);
    if (prompt.imagePaths.length > 0) for (const l of lines) l.tag = new PromptImages(prompt.imagePaths);
    for (const l of lines) out.push(l);
    if (prompt.images > 0 && prompt.imagePaths.length === 0) out.push(line([new Run("  ", "")], prompt.images === 1 ? "[1 image]" : "[" + String(prompt.images) + " images]", palette.dim));
  } else if (!turn.notes) out.push(line([], "◇ " + ctx.agent + " continued on its own", palette.dim));
  const indent: Run[] = [];
  let first = true;
  let calls: Item[] = [];
  const children = turn.body.children;
  // The agent's reply carries its own stamp, on its first words (the first text, else the first thing drawn).
  const reply = ctx.stamps && turn.replyAt > 0 ? messageLabel(turn.replyAt, ctx.agent) : null;
  let stamped: Item | null = null;
  if (reply !== null) {
    for (const c of children) if (c.kind === TEXT) { stamped = c; break; }
    if (stamped === null) for (const c of children) if (c.kind !== TOOL) { stamped = c; break; }
  }
  // One past the last item, so calls at the end are drawn too.
  for (let i = 0; i <= children.length; i++) {
    const item = i < children.length ? children[i] : null;
    if (item !== null && item.kind === TOOL) {
      // A question or plan is drawn as Claude asking (its request), not as a call.
      if (item.category !== QUESTION && item.category !== PLAN) calls.push(item);
      continue;
    }
    const lines = item !== null ? itemLines(item, ctx, indent, width, item === stamped && reply !== null ? reply : undefined) : [];
    // An item that draws nothing (thinking with no words) takes no blank line, and calls on both sides of it are one line.
    if (item !== null && lines.length === 0) continue;
    if (calls.length > 0) {
      out.push(new Line());
      out.push(groupLine(calls, ctx, width));
      calls = [];
      first = false;
    }
    if (item === null) break;
    if (!(first && item.kind === THINKING)) out.push(new Line());
    first = false;
    pushAll(out, lines);
  }
  const result = turn.result;
  if (result !== null) {
    const parts: string[] = [];
    if (result.durationMs > 0) parts.push(took(result.durationMs));
    if (result.costUsd > 0) parts.push("$" + result.costUsd.toFixed(4));
    if (parts.length > 0) {
      out.push(new Line());
      out.push(line([], "  " + (result.isError ? "✗ " : "✓ ") + parts.join(" · "), result.isError ? palette.bad : palette.dim));
    }
  }
  for (const item of turn.after.children) {
    if (out.length > 0) out.push(new Line());
    pushAll(out, itemLines(item, ctx, indent, width));
  }
  out.push(new Line());
  turn.cache = out;
  turn.cacheRev = turn.rev;
  turn.cacheWidth = width;
  return out;
};
