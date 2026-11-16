// The changes, under the files and code columns: three rows on the status band. A summary first
// (how many files and lines changed against the compare base, the open file and where its view is
// among its changes, the branch and the keys), then every changed file, newest first, in columns:
// `●` when Claude edited it in this session, the git mark, the name (with its folder when two share
// one), the lines added and removed, and how long ago it changed (bright for the first seconds).
// The open file is highlighted. A press opens a file, "+N more" shows the Files tab with only the
// changes; `[` `]` in the side and code columns and Alt+↑↓ anywhere walk them.

type Run = widecode.Run;

interface Hit {
  row: number;
  x: number;
  w: number;
  /** "" for the "+N more" cell. */
  path: string;
}

const T = widecode.theme;
const ROWS = 3;
/** The summary's width, fixed so the file columns stay put as the open file changes. */
const SUMMARY_W = 34;
const NAME_MAX = 28;
const GAP = 2;
/** A file changed this recently shows bright. */
const FRESH_MS = 5000;
const DIM = T.dim;
const OPEN_BG = T.selected;
const ADDED = T.ok;
const REMOVED = T.bad;
const MARK_COLORS = T.marks;

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** Each path's shown name: its file name, or its folder and file name when another file shares the name. */
const shownNames = (paths: string[]): Map<string, string> => {
  const seen = new Map<string, number>();
  for (const p of paths) seen.set(baseName(p), (seen.get(baseName(p)) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const p of paths) {
    const parts = p.split("/");
    out.set(p, (seen.get(baseName(p)) ?? 0) < 2 || parts.length < 2 ? baseName(p) : parts[parts.length - 2] + "/" + baseName(p));
  }
  return out;
};

/** "+12 −3", "+5", "−40", "bin"; [] for none. */
const countRuns = (f: widecode.Change): Run[] => {
  if (f.binary) return [{ text: "bin", fg: DIM }];
  const out: Run[] = [];
  if (f.added > 0) out.push({ text: "+" + String(f.added), fg: ADDED });
  if (f.removed > 0) {
    if (out.length > 0) out.push({ text: " ", fg: "" });
    out.push({ text: "−" + String(f.removed), fg: REMOVED });
  }
  return out;
};

widecode.plugin({
  id: "changes",
  activate(api) {
    const u = widecode.util;
    let files: widecode.Change[] = [];
    let repo = true;
    let branch = "";
    let editSeq = -1;
    let hits: Hit[] = [];

    const build = (): void => {
      files = api.state.changes();
      const f = api.state.folder();
      repo = f.repo;
      branch = f.branch;
    };

    const open = (): string => (api.code.inCommit() || api.code.inAgent() ? "" : api.code.path());

    /** The summary's three cells. */
    const summary = (): Run[][] => {
      let added = 0;
      let removed = 0;
      for (const f of files) {
        added += f.added;
        removed += f.removed;
      }
      const first: Run[] = [];
      if (!repo) first.push({ text: "not a git repository", fg: DIM });
      else if (files.length === 0) first.push({ text: "no changes", fg: DIM });
      else first.push({ text: String(files.length) + (files.length === 1 ? " file" : " files"), fg: "", bold: true }, { text: "  +" + String(added), fg: ADDED }, { text: " −" + String(removed), fg: REMOVED });
      const base = api.state.base().name;
      if (repo && base !== "HEAD") first.push({ text: "  vs " + base, fg: T.warn });
      const shown = open();
      const second: Run[] = [];
      if (shown.length > 0) {
        second.push({ text: "▸ " + baseName(shown), fg: T.link, bold: true });
        const at = api.code.position();
        if (at.length > 0) second.push({ text: " · " + at, fg: DIM });
      } else second.push({ text: "no file open", fg: DIM });
      const third: Run[] = [];
      if (branch.length > 0) third.push({ text: "⎇ " + branch + "  ", fg: T.think });
      third.push({ text: "[ ] files · n/p changes", fg: DIM });
      return [first, second, third];
    };

    /** The bar's rows at `width` cells; the file cells' places kept for presses. */
    const lines = (width: number): widecode.Row[] => {
      const now = Date.now();
      const next: Hit[] = [];
      const rows: Run[][] = summary().map((c) => u.pad([{ text: "│ ", fg: DIM }, ...u.clipRuns(c, SUMMARY_W)], 2 + SUMMARY_W));
      const shownPath = open();
      if (files.length > 0) {
        const names = shownNames(files.map((f) => f.path));
        let nameW = 0;
        let countW = 0;
        let ageW = 0;
        for (const f of files) {
          nameW = Math.max(nameW, Math.min(NAME_MAX, u.width(names.get(f.path) ?? f.path)));
          countW = Math.max(countW, u.runsWidth(countRuns(f)));
          if (f.changedMs > 0) ageW = Math.max(ageW, u.age(now - f.changedMs).length);
        }
        const cellW = 3 + nameW + (countW > 0 ? 1 + countW : 0) + (ageW > 0 ? 1 + ageW : 0);
        const start = 2 + SUMMARY_W + 3;
        const columns = Math.max(1, Math.floor((width - start + GAP) / (cellW + GAP)));
        const capacity = columns * ROWS;
        const shown = files.length > capacity ? capacity - 1 : files.length;
        for (const row of rows) row.push({ text: " │ ", fg: DIM });
        const total = shown < files.length ? shown + 1 : shown;
        for (let k = 0; k < total; k++) {
          const row = rows[k % ROWS];
          const x = start + Math.floor(k / ROWS) * (cellW + GAP);
          u.pad(row, x);
          if (k === shown) {
            row.push({ text: "+" + String(files.length - shown) + " more", fg: T.link });
            next.push({ row: k % ROWS, x, w: cellW, path: "" });
            continue;
          }
          const f = files[k];
          const color = MARK_COLORS[f.mark] ?? "";
          const fresh = f.changedMs > 0 && now - f.changedMs < FRESH_MS;
          const cell: Run[] = [
            { text: f.byAgent ? "●" : " ", fg: T.think },
            { text: f.mark, fg: color, bold: true },
            { text: " ", fg: "" },
            { text: u.clip(names.get(f.path) ?? f.path, nameW), fg: fresh ? T.fresh : color, bold: fresh, dim: f.mark === "D" },
          ];
          u.pad(cell, 3 + nameW);
          if (countW > 0) {
            cell.push({ text: " ", fg: "" }, ...countRuns(f));
            u.pad(cell, 3 + nameW + 1 + countW);
          }
          if (ageW > 0) cell.push({ text: " " + (f.changedMs > 0 ? u.age(now - f.changedMs) : "").padStart(ageW, " "), fg: fresh ? T.warn : DIM });
          row.push(...(f.path === shownPath ? cell.map((c) => ({ ...c, bg: OPEN_BG })) : cell));
          next.push({ row: k % ROWS, x, w: cellW, path: f.path });
        }
      }
      hits = next;
      return rows.map((runs) => ({ runs }));
    };

    /** Open the next (1) or previous (-1) changed file, in the bar's order. */
    const step = (direction: number): void => {
      if (files.length === 0) {
        api.tell("no changed files");
        return;
      }
      const at = files.findIndex((f) => f.path === api.code.path());
      const next = at < 0 ? (direction > 0 ? 0 : files.length - 1) : (at + direction + files.length) % files.length;
      api.code.open(files[next].path);
    };

    const band = api.ui.band({
      id: "changes",
      under: "code",
      order: 1,
      lines,
      press: (row, x) => {
        const h = hits.find((c) => c.row === row && x >= c.x && x < c.x + c.w);
        if (h === undefined) return;
        if (h.path.length === 0) api.commands.run("/files changed");
        else api.code.open(h.path);
      },
    });
    const again = (): void => {
      build();
      band.refresh();
    };
    api.on("statusLoaded", again);
    api.on("conversationChanged", () => {
      const seq = api.agent.edits().seq;
      if (seq === editSeq) return;
      editSeq = seq;
      again();
    });
    api.on("baseChanged", () => band.refresh());
    api.on("fileShown", () => band.refresh());
    // The ages move.
    api.every(1000, () => band.refresh());
    // In the side and code columns ([ and ] would type in the chat); from anywhere with Alt.
    for (const scope of ["side", "code", ""])
      for (const back of [true, false])
        api.keys.action({
          id: "changes." + (scope.length > 0 ? scope + "." : "") + (back ? "previous" : "next"),
          scope,
          help: scope.length > 0 ? "changed files" : "",
          key: scope.length > 0 ? (back ? "char:[" : "char:]") : back ? "alt+up" : "alt+down",
          run: () => {
            step(back ? -1 : 1);
            return true;
          },
        });
    build();
  },
});

export {};
