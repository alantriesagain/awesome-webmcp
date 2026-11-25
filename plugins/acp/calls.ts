// A tool call's facts: its kind and the views' category and name for it, its first line, its result
// bounded to a preview, and the diffs that become its patch.

import { obj, str, list } from "./json.ts";
import type { Msg } from "./json.ts";

/** A call's kind as ACP names it, as the views know it, and its name on the call's line. */
export const CATEGORY: Record<string, string> = { read: "read", edit: "edit", delete: "edit", move: "edit", search: "search", execute: "run", fetch: "fetch", switch_mode: "plan", think: "other", other: "other" };
export const NAME: Record<string, string> = { read: "Read", edit: "Edit", delete: "Delete", move: "Move", search: "Search", execute: "Run", fetch: "Fetch", switch_mode: "Mode", think: "Think", other: "Tool" };
/** What a call of one of lightcode's tools is named in the Tools tab, by its kind (another kind: the tool's name). */
export const OWN_NAME: Record<string, string> = { question: "Ask", plan: "Plan" };

/** A call of lightcode's tool `tool`: its first question, its plan's first line, else the tool's name. */
export const ownSummary = (tool: { name: string; category: string }, input: Msg | null): string => {
  if (tool.category === "question") {
    const q = str(obj(list(input?.questions)[0])?.question);
    if (q.length > 0) return q;
  }
  if (tool.category === "plan") {
    const line = str(input?.plan).split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    if (line.length > 0) return line;
  }
  return tool.name;
};

/** How many lines of context a hunk keeps around a change. */
const CONTEXT = 3;
/** Past this many differing lines a diff is one replacement. */
const MAX_EDITS = 500;
/** A whole file before and after is diffed up to this many characters (a call into a plugin has 250 ms). */
export const MAX_WHOLE = 400000;

/** The edit script from `a` to `b` (Myers): " ", "-" and "+" lines; null past MAX_EDITS. */
const editScript = (a: string[], b: string[]): string[] | null => {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Array<number>(2 * max + 3).fill(0);
  /** The furthest x on each diagonal before step d, for the walk back. */
  const trace: number[][] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x < n || y < m) continue;
      const out: string[] = [];
      let cx = n;
      let cy = m;
      for (let e = d; e > 0; e--) {
        const pv = trace[e];
        const ck = cx - cy;
        const down = ck === -e || (ck !== e && pv[off + ck - 1] < pv[off + ck + 1]);
        const px = down ? pv[off + ck + 1] : pv[off + ck - 1];
        const py = px - (down ? ck + 1 : ck - 1);
        while (cx > px && cy > py) {
          cx--;
          cy--;
          out.push(" " + a[cx]);
        }
        if (down) out.push("+" + b[--cy]);
        else out.push("-" + a[--cx]);
      }
      while (cx > 0) {
        cx--;
        out.push(" " + a[cx]);
      }
      return out.reverse();
    }
  }
  return null;
};

const linesOf = (text: string): string[] => (text.length === 0 ? [] : text.replace(/\n$/, "").split("\n"));

/** A diff's hunks from the file's old text ("" for a new file) to its new text. */
export const hunksOf = (oldText: string, newText: string): { oldStart: number; newStart: number; lines: string[] }[] => {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  // The lines both ends share are context; the script is of what lies between.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const mid = editScript(midA, midB) ?? midA.map((l) => "-" + l).concat(midB.map((l) => "+" + l));
  const script = a
    .slice(0, head)
    .map((l) => " " + l)
    .concat(mid, a.slice(a.length - tail).map((l) => " " + l));
  // The old and new line numbers at each line of the script, and where it changes.
  const oldNo: number[] = [];
  const newNo: number[] = [];
  const changes: number[] = [];
  let o = 1;
  let n = 1;
  for (let i = 0; i < script.length; i++) {
    oldNo.push(o);
    newNo.push(n);
    if (!script[i].startsWith("+")) o++;
    if (!script[i].startsWith("-")) n++;
    if (!script[i].startsWith(" ")) changes.push(i);
  }
  // Changes closer than twice the context share a hunk.
  const hunks: { oldStart: number; newStart: number; lines: string[] }[] = [];
  let first = 0;
  for (let c = 0; c < changes.length; c++) {
    if (c + 1 < changes.length && changes[c + 1] - changes[c] - 1 <= 2 * CONTEXT) continue;
    const from = Math.max(0, changes[first] - CONTEXT);
    const to = Math.min(script.length, changes[c] + CONTEXT + 1);
    hunks.push({ oldStart: oldNo[from], newStart: newNo[from], lines: script.slice(from, to) });
    first = c + 1;
  }
  return hunks;
};

/** A unified diff's hunks (`@@ -a,b +c,d @@` and the lines under each). */
export const unifiedHunks = (diff: string): { oldStart: number; newStart: number; lines: string[] }[] => {
  const hunks: { oldStart: number; newStart: number; lines: string[] }[] = [];
  for (const line of diff.split("\n")) {
    const at = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (at !== null) hunks.push({ oldStart: Number(at[1]), newStart: Number(at[2]), lines: [] });
    else if (hunks.length > 0 && (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+"))) hunks[hunks.length - 1].lines.push(line);
  }
  return hunks;
};

/** A tool result past this many characters is kept as its first CUT_HEAD, a line saying how many
 * characters were cut, and its last CUT_TAIL. */
const CUT_AT = 64000;
const CUT_HEAD = 48000;
const CUT_TAIL = 16000;

/** `text` bounded to a preview: its first CUT_HEAD characters, the number cut, its last CUT_TAIL. */
export const cutText = (text: string): { text: string; size: number; truncated: boolean } => {
  if (text.length <= CUT_AT) return { text, size: text.length, truncated: false };
  const cut = text.length - CUT_HEAD - CUT_TAIL;
  return { text: text.slice(0, CUT_HEAD) + "\n[… " + String(cut) + " characters cut by lightcode …]\n" + text.slice(text.length - CUT_TAIL), size: text.length, truncated: true };
};

/**
 * A tool result's fields from its text and raw output: bounded when long, with the full size and
 * who cut it (the agent, when its raw output's metadata says it truncated the output itself, else
 * lightcode).
 */
export const resultOf = (text: string, raw: unknown): { text: string; size?: number; truncated?: "agent" | "lightcode" } => {
  const cut = cutText(text);
  const meta = obj(obj(raw)?.metadata);
  if (meta !== null && meta.truncated === true) return cut.truncated ? { text: cut.text, size: cut.size, truncated: "agent" } : { text: cut.text, truncated: "agent" };
  return cut.truncated ? { text: cut.text, size: cut.size, truncated: "lightcode" } : { text: cut.text };
};
