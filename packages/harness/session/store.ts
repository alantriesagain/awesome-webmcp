// The sessions of a folder as files: `<sessions dir>/<id>.jsonl`, the header line first, then the
// entries appended one by one, each following the last (`parentId`); the file is made on the
// first entry, so a session never written leaves nothing; a removed file is made again by the
// next append. The list reads each file's header and its last title through a backwards window,
// never a whole file; a load reads the whole file once and walks the branch back from its last
// entry; a fork copies the branch into a new file.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listText, objectText } from "@light/lib/json.ts";
import { readWindow } from "@light/workspace/window.ts";
import { Entry, SESSION, TITLE } from "./entries.ts";

/** How much of a session file a load reads (one of many megabytes is cut at its start). */
const LOAD_MAX = 64 * 1024 * 1024;
const TITLE_WINDOW = 64 * 1024;

/** A session as the list says it. */
export class SessionListed {
  readonly id: string;
  readonly cwd: string;
  title = "";
  updatedMs = 0;
  startedMs = 0;

  constructor(id: string, cwd: string) {
    this.id = id;
    this.cwd = cwd;
  }
}

/** One session's file, appended to as the session goes. */
export class SessionFile {
  readonly store: SessionStore;
  readonly id: string;
  readonly cwd: string;
  /** The last entry's id, what the next one follows ("" before any). */
  leaf = "";
  /** The highest entry number given or seen ("e<n>"). */
  seq = 0;

  constructor(store: SessionStore, id: string, cwd: string) {
    this.store = store;
    this.id = id;
    this.cwd = cwd;
  }

  path(): string {
    return this.store.pathOf(this.id);
  }

  /** The next entry id ("e1", "e2", ...), past those loaded. */
  nextId(): string {
    this.seq++;
    return "e" + String(this.seq);
  }

  /** Ids up to `n` are taken (after a load). */
  seen(n: number): void {
    if (n > this.seq) this.seq = n;
  }

  /** Append `e` after the leaf, the file (and its header) made when missing. */
  append(e: Entry): void {
    if (e.id.length === 0) e.id = this.nextId();
    if (e.at === 0) e.at = Date.now();
    e.parentId = this.leaf;
    const path = this.path();
    if (!existsSync(path)) {
      mkdirSync(this.store.dir, { recursive: true });
      const head = new Entry(SESSION);
      head.id = this.id;
      head.cwd = this.cwd;
      head.at = e.at;
      writeFileSync(path, head.line() + "\n");
    }
    appendFileSync(path, e.line() + "\n");
    this.leaf = e.id;
  }
}

export class SessionStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  pathOf(id: string): string {
    return join(this.dir, id + ".jsonl");
  }

  /** A session's file to append to (made on the first entry). */
  open(id: string, cwd: string): SessionFile {
    return new SessionFile(this, id, cwd);
  }

  /** Every entry of session `id`'s file with its header, in file order; null when there is no such file. */
  read(id: string): { header: Entry | null; entries: Entry[] } | null {
    const path = this.pathOf(id);
    if (!existsSync(path)) return null;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    if (text.length > LOAD_MAX) text = text.slice(text.length - LOAD_MAX);
    let header: Entry | null = null;
    const entries: Entry[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const e = Entry.parse(line);
      if (e === null) continue;
      if (e.kind === SESSION) header = e;
      else entries.push(e);
    }
    return { header, entries };
  }

  /** The entries of session `id`'s active branch, oldest first, the header left out; null when there is no such file. The file's object is set to continue it. */
  load(id: string): { file: SessionFile; entries: Entry[] } | null {
    const path = this.pathOf(id);
    if (!existsSync(path)) return null;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    if (text.length > LOAD_MAX) text = text.slice(text.length - LOAD_MAX);
    const lines = text.split("\n");
    const byId = new Map<string, Entry>();
    let header: Entry | null = null;
    let last: Entry | null = null;
    let top = 0;
    for (const line of lines) {
      if (line.length === 0) continue;
      const e = Entry.parse(line);
      if (e === null) continue;
      if (e.kind === SESSION) {
        header = e;
        continue;
      }
      byId.set(e.id, e);
      last = e;
      const n = /^e(\d+)$/.exec(e.id);
      if (n !== null && Number(n[1]) > top) top = Number(n[1]);
    }
    const file = new SessionFile(this, id, header !== null ? header.cwd : "");
    file.seen(top);
    // The branch: from the last entry back to the first, through parent ids; an entry whose parent is unknown ends the walk.
    const branch: Entry[] = [];
    let at: Entry | null = last;
    const seen = new Set<string>();
    while (at !== null && !seen.has(at.id)) {
      seen.add(at.id);
      branch.push(at);
      const parent = at.parentId.length > 0 ? byId.get(at.parentId) : undefined;
      at = parent === undefined ? null : parent;
    }
    branch.reverse();
    file.leaf = last !== null ? last.id : "";
    return { file, entries: branch };
  }

  /** The sessions of `cwd` (every one when `cwd` is ""), newest first. */
  list(cwd: string): SessionListed[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: SessionListed[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(this.dir, name);
      const head = readWindow(path, 2048, 4096, []);
      const first = head.lines.length > 0 ? Entry.parse(head.lines[0]) : null;
      if (first === null || first.kind !== SESSION) continue;
      if (cwd.length > 0 && first.cwd !== cwd) continue;
      const s = new SessionListed(first.id, first.cwd);
      s.startedMs = first.at;
      try {
        s.updatedMs = statSync(path).mtimeMs;
      } catch {
        s.updatedMs = first.at;
      }
      const tail = readWindow(path, -1, TITLE_WINDOW, []);
      for (let i = tail.lines.length - 1; i >= 0; i--) {
        if (!tail.lines[i].startsWith('{"kind":"title"')) continue;
        const t = Entry.parse(tail.lines[i]);
        if (t !== null && t.kind === TITLE) {
          s.title = t.value;
          break;
        }
      }
      out.push(s);
    }
    out.sort((a, b) => b.updatedMs - a.updatedMs);
    return out;
  }

  /** Session `id`'s branch copied as session `newId` (a side question's fork), the copy's file to continue; null when there is none to copy. */
  fork(id: string, newId: string): SessionFile | null {
    const got = this.load(id);
    if (got === null) return null;
    const file = this.open(newId, got.file.cwd);
    for (const e of got.entries) {
      const copy = Entry.parse(e.line());
      if (copy === null) continue;
      file.append(copy);
    }
    file.seen(got.file.seq);
    return file;
  }

  remove(id: string): boolean {
    const path = this.pathOf(id);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }
}

/** A listing as ACP's `session/list` answers it and the `sessions` side command prints it. */
export const sessionsJson = (sessions: SessionListed[]): string =>
  listText(sessions.map((s) => objectText(["sessionId", "cwd", "title", "updatedAt"], [JSON.stringify(s.id), JSON.stringify(s.cwd), JSON.stringify(s.title), String(Math.round(s.updatedMs))])));
