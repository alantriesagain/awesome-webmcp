// A file for the code view: its lines, each kept, added or removed against a base (HEAD, or the
// commit the Git tab compares with). In a work tree the lines come from `git diff -U<all> <base>`
// (one hunk holding the whole file), so git decides the diff; a file outside git is plain. A file
// new against the base (untracked, added, or there is no commit yet) would be all added, so it is
// plain too, marked as new. A file as one commit changed it comes from
// `git diff -U<all> <parent> <commit>` (one the commit added, a root commit's: new).
// Tabs are expanded: the terminal grid gives a tab no width.
import { insidePath, readFileCapped } from "@light/workspace/files.ts";
import { GitRepo, isBinary } from "@light/workspace/git.ts";
import { Commit } from "@light/workspace/git-log.ts";
import { git } from "@light/workspace/git.read.ts";
import { HlState, languageForPath, Token, tokenizeLine } from "@light/highlight";
import { expandTabs } from "@light/ui/text.ts";

export const KEPT = 0;
export const ADDED = 1;
export const REMOVED = 2;
/** The most of a file (or of its diff) the view loads. */
const CODE_MAX = 4 * 1024 * 1024;
/** Past this many lines a file is shown without colors. */
const HIGHLIGHT_MAX = 30000;

export class CodeLine {
  kind: number;
  /** Line numbers in HEAD and in the file on disk; 0 where the line has none. */
  oldNo: number;
  newNo: number;
  text: string;
  /** Syntax tokens over `text` (empty when the file's language is not highlighted). */
  tokens: Token[] = [];

  constructor(kind: number, oldNo: number, newNo: number, text: string) {
    this.kind = kind;
    this.oldNo = oldNo;
    this.newNo = newNo;
    this.text = text;
  }
}

export class CodeFile {
  path = "";
  exists = false;
  binary = false;
  truncated = false;
  size = 0;
  /** Why the view shows less than the file ("" when it shows it all). */
  note = "";
  /** New against its base: shown as plain code, its lines kept, since every one would be added. */
  added = false;
  lines: CodeLine[] = [];
  /** The index of each change's first line, in order. */
  hunks: number[] = [];
}

export { expandTabs };

const splitLines = (text: string): string[] => {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

const plainLines = (text: string, kind: number): CodeLine[] => {
  const out: CodeLine[] = [];
  let n = 1;
  for (const l of splitLines(text)) {
    out.push(new CodeLine(kind, kind === ADDED ? 0 : n, n, expandTabs(l)));
    n++;
  }
  return out;
};

/** The lines of a unified diff's hunks; headers and "\ No newline" markers left out. */
export const parseUnified = (text: string): CodeLine[] => {
  const out: CodeLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const l of splitLines(text)) {
    if (l.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) continue;
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const c = l.charAt(0);
    const body = expandTabs(l.slice(1));
    if (c === " ") out.push(new CodeLine(KEPT, oldNo++, newNo++, body));
    else if (c === "+") out.push(new CodeLine(ADDED, 0, newNo++, body));
    else if (c === "-") out.push(new CodeLine(REMOVED, oldNo++, 0, body));
  }
  return out;
};

/** Where each run of changed lines starts. */
export const hunkStarts = (lines: CodeLine[]): number[] => {
  const out: number[] = [];
  let inChange = false;
  for (let i = 0; i < lines.length; i++) {
    const changed = lines[i].kind !== KEPT;
    if (changed && !inChange) out.push(i);
    inChange = changed;
  }
  return out;
};

/**
 * Color the lines: once through the file as it is (kept and added lines) and once as HEAD has it
 * (kept and removed lines), so each version's multi-line constructs carry over correctly.
 */
const highlightLines = (lines: CodeLine[], language: string): void => {
  if (language.length === 0 || lines.length > HIGHLIGHT_MAX) return;
  const now = new HlState();
  const before = new HlState();
  for (const l of lines) {
    if (l.kind !== REMOVED) l.tokens = tokenizeLine(language, l.text, now);
    if (l.kind !== ADDED) {
      const t = tokenizeLine(language, l.text, before);
      if (l.kind === REMOVED) l.tokens = t;
    }
  }
};

/** A file new against its base: its lines as plain code, the file marked `added`. */
const asNew = (file: CodeFile, lines: CodeLine[]): CodeFile => {
  file.added = true;
  for (const l of lines) {
    l.kind = KEPT;
    l.oldNo = 0;
  }
  return finish(file, lines);
};

const finish = (file: CodeFile, lines: CodeLine[]): CodeFile => {
  file.lines = lines;
  file.hunks = hunkStarts(lines);
  highlightLines(lines, languageForPath(file.path));
  return file;
};

/** Load `path` (folder-relative) with its changes against `base`; `untracked` when git status says so. */
export const loadCode = async (repo: GitRepo, folder: string, path: string, untracked: boolean, base: string): Promise<CodeFile> => {
  const file = new CodeFile();
  file.path = path;
  if (insidePath(folder, path).length === 0) {
    file.note = "outside the folder";
    return file;
  }
  const current = readFileCapped(folder, path, CODE_MAX);
  file.exists = current.exists;
  file.size = current.size;
  file.truncated = current.truncated;
  if (current.truncated) file.note = "showing the first " + String(Math.round(CODE_MAX / 1048576)) + " MB";
  if (current.binary) {
    file.binary = true;
    file.note = "binary file";
    return file;
  }
  if (!repo.isRepo) return finish(file, plainLines(current.text, KEPT));
  if (untracked) return asNew(file, plainLines(current.text, KEPT));
  const run = await git(["--literal-pathspecs", "diff", "--no-color", "--no-ext-diff", "--unified=1000000000", base, "--", path], folder, CODE_MAX);
  if (!run.ok) return current.exists ? asNew(file, plainLines(current.text, KEPT)) : finish(file, []);
  if (run.out.length === 0) return finish(file, current.exists ? plainLines(current.text, KEPT) : []);
  return fromDiff(file, run.out, run.text, run.truncated);
};

/** The file's lines from a whole-file diff's output. */
const fromDiff = (file: CodeFile, out: Buffer, text: string, truncated: boolean): CodeFile => {
  if (isBinary(out) || /^Binary files /m.test(text)) {
    file.binary = true;
    file.note = "binary file";
    return file;
  }
  if (truncated) {
    file.truncated = true;
    file.note = "the diff is larger than " + String(Math.round(CODE_MAX / 1048576)) + " MB; showing the start";
  }
  if (/^new file mode/m.test(text)) return asNew(file, parseUnified(text));
  return finish(file, parseUnified(text));
};

/** `path` as `commit` left it, with that commit's changes in place (a file it deleted: all removed). */
export const loadCommitFile = async (repo: GitRepo, folder: string, commit: Commit, path: string): Promise<CodeFile> => {
  const file = new CodeFile();
  file.path = path;
  if (insidePath(folder, path).length === 0) {
    file.note = "outside the folder";
    return file;
  }
  if (!repo.isRepo) return file;
  file.exists = true;
  const flags = ["--literal-pathspecs"];
  if (commit.parents.length === 0) {
    const shown = await git(flags.concat(["show", commit.sha + ":./" + path]), folder, CODE_MAX);
    if (!shown.ok) {
      file.note = "not in this commit";
      return finish(file, []);
    }
    if (isBinary(shown.out)) {
      file.binary = true;
      file.note = "binary file";
      return file;
    }
    return asNew(file, plainLines(shown.text, KEPT));
  }
  const run = await git(flags.concat(["diff", "--no-color", "--no-ext-diff", "--no-renames", "--unified=1000000000", commit.parents[0], commit.sha, "--", path]), folder, CODE_MAX);
  if (!run.ok || run.out.length === 0) {
    file.note = "unchanged in this commit";
    return finish(file, []);
  }
  if (/^deleted file mode/m.test(run.text)) file.exists = false;
  return fromDiff(file, run.out, run.text, run.truncated);
};
