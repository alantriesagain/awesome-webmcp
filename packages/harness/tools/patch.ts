// A change as the code column shows it: the hunks from a file's old text to its new one (Myers'
// edit script between the parts the two ends do not share, three lines of context, changes
// closer than that sharing a hunk; past 500 differing lines one replacement), and the same as a
// unified diff with the file's line numbers, the shape the acp plugin's reader takes from
// `rawOutput.metadata.filediff.patch`. Ported from the plugin, which diffs an agent's whole files.

const CONTEXT = 3;
const MAX_EDITS = 500;

export class Hunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: string[];

  constructor(oldStart: number, newStart: number, lines: string[]) {
    this.oldStart = oldStart;
    this.newStart = newStart;
    this.lines = lines;
  }
}

/** The edit script from `a` to `b`: " ", "-" and "+" lines; null past MAX_EDITS. */
const editScript = (a: string[], b: string[]): string[] | null => {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Array<number>(2 * max + 3).fill(0);
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

/** The hunks from `oldText` ("" for a new file) to `newText`. */
export const hunksOf = (oldText: string, newText: string): Hunk[] => {
  const a = linesOf(oldText);
  const b = linesOf(newText);
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
  const hunks: Hunk[] = [];
  let first = 0;
  for (let c = 0; c < changes.length; c++) {
    if (c + 1 < changes.length && changes[c + 1] - changes[c] - 1 <= 2 * CONTEXT) continue;
    const from = Math.max(0, changes[first] - CONTEXT);
    const to = Math.min(script.length, changes[c] + CONTEXT + 1);
    hunks.push(new Hunk(oldNo[from], newNo[from], script.slice(from, to)));
    first = c + 1;
  }
  return hunks;
};

/** The hunks as a unified diff of `path` (`@@ -a,b +c,d @@` and the lines under each). */
export const unifiedPatch = (path: string, hunks: Hunk[]): string => {
  const out: string[] = ["--- a/" + path, "+++ b/" + path];
  for (const h of hunks) {
    const oldCount = h.lines.filter((l) => !l.startsWith("+")).length;
    const newCount = h.lines.filter((l) => !l.startsWith("-")).length;
    out.push("@@ -" + String(h.oldStart) + "," + String(oldCount) + " +" + String(h.newStart) + "," + String(newCount) + " @@");
    for (const l of h.lines) out.push(l);
  }
  return out.join("\n") + "\n";
};

/** How many lines the hunks add and remove. */
export const counts = (hunks: Hunk[]): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  return { added, removed };
};
