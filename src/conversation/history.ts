// The messages written in a folder, for the composer's ↑ and ↓: widecode's own log of them,
// `<folder>/.widecode/history.jsonl`, one {"ts", "session", "text"} object per line, appended as
// each is sent. Past MAX_BYTES the file moves aside to history.1.jsonl (an older one to .2, and so
// on) and a new one starts, so nothing written is lost. The log is read on the first ↑, newest file
// first, older files as the walk reaches them; a message repeated in a row is walked once. Without
// a folder to write in (--ephemeral) the history is this run's only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** A log past this size moves aside. */
const MAX_BYTES = 4 * 1024 * 1024;

const FILE = "history.jsonl";

/** How many older logs are kept, and how many of a file's lines are parsed in one step. */
const MAX_FILES = 10;
const MAX_LINES = 5000;

/** The texts of a log's lines, newest first. */
const textsOf = (path: string): string[] => {
  const out: string[] = [];
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - MAX_LINES); i--) {
    if (lines[i].length === 0) continue;
    try {
      const v = JSON.parse(lines[i]) as { text?: unknown };
      if (typeof v.text === "string" && v.text.length > 0) out.push(v.text);
    } catch {
      continue;
    }
  }
  return out;
};

export class PromptHistory {
  /** Where the log is (`<folder>/.widecode`), "" to keep it in memory only. */
  readonly dir: string;
  /** Past this size the log moves aside. */
  maxBytes = MAX_BYTES;
  /** What was read and added, newest first, repeats in a row collapsed. */
  private entries: string[] = [];
  /** Whether the log was read, and how many of its files. */
  private loaded = false;
  private files = 0;
  private more = true;
  /** For a run without a log: what was added. */
  private memory: string[] = [];

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Keep `text`, sent in session `session` (now, at `ts`). */
  add(text: string, session: string, ts: number): void {
    if (text.trim().length === 0) return;
    if (this.dir.length === 0) {
      if (this.memory.length === 0 || this.memory[0] !== text) this.memory.unshift(text);
      return;
    }
    const path = join(this.dir, FILE);
    try {
      mkdirSync(this.dir, { recursive: true });
      if (existsSync(path) && statSync(path).size > this.maxBytes) {
        this.rotate();
        // The files moved under the walk: it reads them again.
        this.loaded = false;
      }
      const v: unknown = { ts, session, text };
      appendFileSync(path, JSON.stringify(v) + "\n");
    } catch {
      return;
    }
    if (this.loaded && (this.entries.length === 0 || this.entries[0] !== text)) this.entries.unshift(text);
  }

  /** The message `index` back (0 the newest); null past the oldest. Older files are read as the walk needs them. */
  at(index: number): string | null {
    if (this.dir.length === 0) return index < this.memory.length ? this.memory[index] : null;
    if (!this.loaded) {
      this.entries = [];
      this.files = 0;
      this.more = true;
      this.loaded = true;
    }
    while (index >= this.entries.length && this.more) this.readNext();
    return index < this.entries.length ? this.entries[index] : null;
  }

  /** The next older file into the walk (history.jsonl, then .1, .2, ...). */
  private readNext(): void {
    const path = join(this.dir, this.files === 0 ? FILE : "history." + String(this.files) + ".jsonl");
    if (!existsSync(path)) {
      this.more = false;
      return;
    }
    this.files++;
    for (const text of textsOf(path)) if (this.entries.length === 0 || this.entries[this.entries.length - 1] !== text) this.entries.push(text);
  }

  /** history.jsonl to history.1.jsonl, an older .N to .N+1. */
  private rotate(): void {
    let n = 1;
    while (existsSync(join(this.dir, "history." + String(n) + ".jsonl"))) n++;
    while (n >= MAX_FILES) {
      rmSync(join(this.dir, "history." + String(n) + ".jsonl"), { force: true });
      n--;
    }
    for (let i = n - 1; i >= 1; i--) renameSync(join(this.dir, "history." + String(i) + ".jsonl"), join(this.dir, "history." + String(i + 1) + ".jsonl"));
    renameSync(join(this.dir, FILE), join(this.dir, "history.1.jsonl"));
  }
}
