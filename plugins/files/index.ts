// The Files tab of the side column: the folder's tree with its git marks (a changed file's name,
// and a folder holding changes, in the change's color), the file in the code column selected and
// its folders opened. A switch above it shows every file or only the changed ones (c, a press on
// it, /files all|changed, the changes strip's "+N more"), kept between runs. A press on a folder
// opens or closes it, on a file opens it; ↑↓ move a cursor, Enter or → opens, ← closes a folder or
// goes to the parent. The tree itself is the core's, built once per file list and status read.

type Run = lightcode.Run;

const T = lightcode.theme;
const ALL = " All ";
const CHANGED = " Changed ";
const ON_BG = T.selected;
const MARK_COLORS = T.marks;

/** The folders to open so `path` shows. */
const ancestors = (path: string): string[] => {
  const out: string[] = [];
  let cut = path.indexOf("/");
  while (cut > 0) {
    out.push(path.slice(0, cut));
    cut = path.indexOf("/", cut + 1);
  }
  return out;
};

const rowOf = (r: lightcode.TreeRow, selected: string): lightcode.Row => {
  const color = r.mark.length > 0 ? (MARK_COLORS[r.mark] ?? "") : "";
  const runs: Run[] = [
    { text: " ".repeat(1 + r.depth * 2) + (r.dir ? (r.open ? "▾ " : "▸ ") : "  "), fg: T.dim },
    { text: r.name, fg: color, bold: r.dir, dim: r.mark === "D" },
  ];
  if (r.mark.length > 0) runs.push({ text: " " + r.mark, fg: color, bold: true });
  return { bg: r.path === selected ? ON_BG : "", runs };
};

lightcode.plugin({
  id: "files",
  activate(api) {
    const expanded = new Set<string>();
    const kept = api.settings.state() as { changedOnly?: unknown } | null;
    let changedOnly = kept !== null && kept.changedOnly === true;
    let rows: lightcode.TreeRow[] = [];
    let total = "";
    let changed = 0;
    /** The open file's row, highlighted, and the row the keyboard is on. */
    let selected = "";
    let cursor = 0;

    /** The rows again from the tree, the open folders and the switch. */
    const layout = (): void => {
      const t = api.files.tree(Array.from(expanded), changedOnly);
      rows = t.rows;
      total = String(t.total) + (t.truncated ? "+" : "");
      changed = t.changed;
      if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1);
      panel.refresh();
    };

    /** Show only the changed files (true) or all of them. */
    const showChanged = (only: boolean): void => {
      if (changedOnly === only) return;
      changedOnly = only;
      layout();
      api.settings.setState({ changedOnly });
    };

    const indexOf = (path: string): number => rows.findIndex((r) => r.path === path);

    /** Open or close a folder, open a file. */
    const activate = (row: lightcode.TreeRow | undefined): void => {
      if (row === undefined) return;
      if (!row.dir) {
        api.code.open(row.path);
        return;
      }
      if (expanded.has(row.path)) expanded.delete(row.path);
      else expanded.add(row.path);
      layout();
    };

    /** Mark `path` as the open file, opening its folders and scrolling it into view. */
    const select = (path: string): void => {
      selected = path;
      for (const d of ancestors(path)) expanded.add(d);
      layout();
      const at = indexOf(path);
      if (at >= 0) {
        cursor = at;
        panel.reveal(at);
      }
    };

    /** The cursor on row `at`, its path highlighted. */
    const moveTo = (at: number): void => {
      cursor = at;
      const r = rows[at];
      if (r !== undefined) selected = r.path;
      panel.reveal(at);
      panel.refresh();
    };

    const panel = api.ui.panel({
      id: "files",
      title: "Files",
      order: 0,
      count: () => rows.length,
      rows: (from, count) => rows.slice(from, from + count).map((r) => rowOf(r, selected)),
      badge: () => (changed > 0 ? [{ text: String(changed), fg: T.warn }] : []),
      info: () => [
        { text: ALL + total, fg: changedOnly ? T.dim : T.link, bold: !changedOnly, bg: changedOnly ? "" : ON_BG },
        { text: "│", fg: T.dim },
        { text: CHANGED + String(changed) + " ", fg: changedOnly ? T.link : T.dim, bold: changedOnly, bg: changedOnly ? ON_BG : "" },
      ],
      infoPress: (x) => showChanged(x >= ALL.length + total.length + 1),
      press: (row) => {
        cursor = row;
        activate(rows[row]);
      },
      shown: () => panel.reveal(cursor),
    });

    api.on("filesLoaded", layout);
    api.on("statusLoaded", layout);
    api.on("fileShown", () => {
      if (!api.code.inCommit() && !api.code.inAgent()) select(api.code.path());
    });
    const move = (step: number): boolean => {
      moveTo(Math.max(0, Math.min(rows.length - 1, cursor + step)));
      return true;
    };
    api.keys.action({ id: "files.up", scope: "files", help: "opens", key: "up", run: () => move(-1) });
    api.keys.action({ id: "files.down", scope: "files", help: "opens", key: "down", run: () => move(1) });
    // Enter opens a file or folds a folder either way; → only opens.
    api.keys.action({
      id: "files.open",
      scope: "files",
      help: "opens",
      key: "enter",
      run: () => {
        activate(rows[cursor]);
        return true;
      },
    });
    api.keys.action({
      id: "files.expand",
      scope: "files",
      key: "right",
      run: () => {
        const row = rows[cursor];
        if (row !== undefined && (!row.dir || !row.open)) activate(row);
        return true;
      },
    });
    api.keys.action({
      id: "files.collapse",
      scope: "files",
      key: "left",
      run: () => {
        const row = rows[cursor];
        if (row !== undefined && row.dir && row.open) activate(row);
        else if (row !== undefined) {
          const parent = ancestors(row.path).pop();
          const at = parent !== undefined ? indexOf(parent) : -1;
          if (at >= 0) moveTo(at);
        }
        return true;
      },
    });
    api.keys.action({
      id: "files.changed",
      scope: "files",
      help: "changed",
      key: "char:c",
      run: () => {
        showChanged(!changedOnly);
        return true;
      },
    });
    api.commands.add({
      name: "/files",
      usage: "<all|changed>",
      help: "the Files tab, every file or only the changed ones",
      run: (arg) => {
        if (arg === "changed" || arg === "all") showChanged(arg === "changed");
        api.actions.showPanel("files");
      },
    });
    layout();
  },
});

export {};
