// The session's status: a table spanning the chat and tools columns, and optionally one under the
// tools column alone, each laid out by config.json (the status section's `lines` and `toolsLines`),
// each line a row of cells, a cell one segment or several joined by " · ", cell i of every row as
// wide as the widest so like things stack, each row's last cell free to grow (the text: title,
// activity, hints). Segments come from any plugin by name (this one draws the session's: folder,
// branch, effort, the approval mode when it is not ask, title, context, limits, cache, activity and
// its clock, tools, calls, thinking, cost, time, queued, the message or the message alone); a cell
// can also run the user's command, which gets Claude Code's status line JSON on stdin and prints
// colored lines. A press on a cell runs its segment's press (the mode toggles plan mode, the title
// says how to rename). The message cells read the status message as the core draws, so a new
// message redraws the table by itself.

type Run = lightcode.Run;

interface Spec {
  segment: string;
  cell: number;
  fg: string;
  label: string;
  command: string;
  interval: number;
}

interface Cell {
  runs: Run[];
  names: string[];
  right: boolean;
  x: number;
  w: number;
}

const T = lightcode.theme;
const DIM = T.dim;
const OK = T.ok;
const WARN = T.warn;
const BAD = T.bad;
/** The room each row's last cell keeps: past it, columns are dropped from the right. */
const TEXT_MIN = 32;
/** Cells kept clear at the bar's right edge, before the strip beside it. */
const RIGHT_GAP = 4;
const COMMAND_MS = 2000;
const DEBOUNCE_MS = 300;

/** Across the chat and tools columns: the session, its work and its clocks. */
const DEFAULT_LINES = [
  [["project"], ["context"], ["cache"], ["title"]],
  [["branch"], ["limit5h"], ["duration", "cost"], ["tools"], ["activity"]],
  [["model", "effort"], ["limitWeek"], ["mode", "box"], ["thinking"], ["peers", "message"]],
];
/** Under the tools column alone: nothing by default (the table above already spans it). */
const DEFAULT_TOOLS_LINES: string[][][] = [];
/** The defaults earlier versions wrote, replaced by the current one where untouched: a shape of plain segments, and the lines as written. */
const PREVIOUS_DEFAULT = "project branch model effort mode title spacer note|context limit5h limitWeek cache|activity tools calls thinking cost duration";
const PREVIOUS_LINES = [
  JSON.stringify([["project", "context", "cost", "title"], [["model", "effort"], "limit5h", "duration", "note"], ["mode", "limitWeek", "cache"]]),
  JSON.stringify([["project", "context", "cache", "cost", "title"], ["branch", "limit5h", "tools", "duration", "activity"], [["model", "effort"], "limitWeek", ["calls", "thinking"], "mode", "note"]]),
  JSON.stringify([["project", "context", "cache", "cost", "title"], ["branch", "limit5h", "tools", "duration", "activity"], [["model", "effort"], "limitWeek", "calls", "mode", "note"]]),
  JSON.stringify([["project", "context", "cost", "title"], [["model", "effort"], "limit5h", "duration", "note"], ["mode", "limitWeek", "cache", "peers"]]),
];
const COLOR = /^(#[0-9a-fA-F]{6}|[0-9]{1,3}|default|gray|grey|black|red|green|yellow|blue|magenta|cyan|white|bright(black|red|green|yellow|blue|magenta|cyan|white))$/;

const run = (text: string, fg: string, more?: Partial<Run>): Run => ({ text, fg, ...more });
const safeColor = (c: string): string => (COLOR.test(c) ? c : "");

const { width, runsWidth, clip, clipRuns, tokens, elapsed } = lightcode.util;
const percentColor = (pct: number): string => (pct < 50 ? OK : pct < 80 ? WARN : BAD);
const bar = (pct: number): Run[] => {
  const filled = Math.max(0, Math.min(8, Math.round((pct / 100) * 8)));
  return [run("▰".repeat(filled), percentColor(pct)), run("▱".repeat(8 - filled), DIM)];
};
/** Time until `epochSeconds` as "3h54m", "2d0h" or "12m". */
const countdown = (epochSeconds: number, now: number): string => {
  const s = Math.max(0, Math.round(epochSeconds - now / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return String(d) + "d" + String(h) + "h";
  if (h > 0) return String(h) + "h" + String(m) + "m";
  return String(m) + "m";
};
/** A percent right-aligned in four cells (" 79%", "  5%"), so the meters stack. */
const percent = (pct: number): string => String(Math.round(pct)).padStart(3, " ") + "%";
const limit = (label: string, pct: number, resets: number, now: number): Run[] => {
  if (pct < 0) return [];
  const out = [run(label.padEnd(3, " ") + " ", DIM), ...bar(pct), run(" " + percent(pct), percentColor(pct))];
  if (resets > 0) out.push(run(" ↻" + countdown(resets, now), DIM));
  return out;
};

/** The session's segments, from the status line input (`ctx.info`, Claude Code's shape plus lightcode's). */
const SEGMENTS: Record<string, (ctx: lightcode.SegmentContext) => Run[]> = {
  project: (ctx) =>
    ctx.busy
      ? [run(ctx.spinner, T.link, { bold: true, live: "spinner" }), run(" " + ctx.folderName, T.link, { bold: true })]
      : [run("◆ " + ctx.folderName, T.link, { bold: true })],
  branch: (ctx) => (ctx.info.lightcode.branch ? [run(ctx.info.lightcode.branch, T.think)] : []),
  effort: (ctx) => (ctx.info.effort.level ? [run(ctx.info.effort.level, DIM)] : []),
  mode: (ctx) => {
    const mode = String(ctx.info.lightcode.mode ?? "");
    return mode === "plan" ? [run("plan mode", WARN)] : [run(mode === "bypassPermissions" || mode.length === 0 ? "bypass" : mode, DIM)];
  },
  title: (ctx) => (ctx.info.session_name ? [run(clip(String(ctx.info.session_name).replace(/\s+/g, " "), 48), "")] : []),
  context: (ctx) => {
    const w = ctx.info.context_window;
    const u = w.current_usage;
    const used = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
    const size = w.context_window_size;
    const pct = size > 0 ? (used / size) * 100 : 0;
    return [run("ctx ", DIM), ...bar(pct), run(" " + percent(pct), percentColor(pct)), run(" " + tokens(used) + "/" + tokens(size), DIM)];
  },
  limit5h: (ctx) => limit("5h", ctx.info.rate_limits.five_hour.used_percentage, ctx.info.rate_limits.five_hour.resets_at, ctx.now),
  limitWeek: (ctx) => limit("wk", ctx.info.rate_limits.seven_day.used_percentage, ctx.info.rate_limits.seven_day.resets_at, ctx.now),
  cache: (ctx) => {
    const c = ctx.info.prompt_cache;
    if (c.requests === 0) return [];
    const warm = c.warm === true;
    const out = [run("cache ", DIM), run(warm ? "●" : "○", warm ? OK : DIM)];
    if (warm) out.push(run(" " + elapsed(c.expires_at * 1000 - ctx.now), DIM));
    const hit = Math.round(c.hit_ratio * 100);
    out.push(run(" " + String(hit) + "% hit", hit >= 80 ? OK : hit >= 50 ? WARN : BAD));
    out.push(run(" · " + String(c.misses) + " miss", c.misses > 0 ? WARN : DIM));
    return out;
  },
  activity: (ctx) => {
    const a = String(ctx.info.lightcode.activity ?? "");
    if (a.length === 0) return [];
    const ms = Number(ctx.info.lightcode.activity_ms ?? -1);
    const clock = ms >= 0 ? [run(" " + elapsed(ms), WARN)] : [];
    if (a === "thinking" || a === "compacting") return [run("✻ " + a + "…", T.think, { italic: true }), ...clock];
    const space = a.indexOf(" ");
    const tool = space > 0 ? a.slice(0, space) : a;
    const rest = space > 0 ? a.slice(space) : "";
    // The clock before what the call was given, which the cell's edge may cut.
    return [run("↳ " + tool, "", { bold: true }), ...clock, run(clip(rest, 40), DIM)];
  },
  tools: (ctx) => {
    const w = ctx.info.lightcode;
    return [run("R ", DIM), run(String(w.reads), T.link), run(" W ", DIM), run(String(w.writes), WARN), run(" X ", DIM), run(String(w.execs), BAD), run(" A ", DIM), run(String(w.agents), T.think)];
  },
  calls: (ctx) => [run(String(ctx.info.lightcode.calls), ""), run(ctx.info.lightcode.calls === 1 ? " call" : " calls", DIM)],
  thinking: (ctx) => (ctx.info.lightcode.thinking_tokens > 0 ? [run("think ", DIM), run(tokens(ctx.info.lightcode.thinking_tokens), T.think)] : []),
  cost: (ctx) => (ctx.info.cost.total_cost_usd > 0 ? [run("$" + Number(ctx.info.cost.total_cost_usd).toFixed(2), OK)] : []),
  duration: (ctx) => (ctx.info.cost.total_duration_ms > 0 ? [run(elapsed(ctx.info.cost.total_duration_ms), DIM)] : []),
  queued: (ctx) => (ctx.info.lightcode.queued > 0 ? [run(String(ctx.info.lightcode.queued) + " queued", WARN)] : []),
  note: (ctx) => (ctx.note.length > 0 ? [run(ctx.note, DIM)] : []),
  message: (ctx) => (ctx.message.length > 0 ? [run(ctx.message, DIM)] : []),
};

/** A line of terminal output with ANSI escapes as runs: SGR colors and styles kept, other escapes dropped, a hyperlink's text kept. */
const parseAnsi = (line: string): Run[] => {
  const out: Run[] = [];
  let pen: Run = { text: "", fg: "" };
  let text = "";
  const flush = (): void => {
    if (text.length > 0) out.push({ ...pen, text });
    text = "";
  };
  const hex = (n: number): string => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  const sgr = (params: number[]): void => {
    if (params.length === 0) params = [0];
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) pen = { text: "", fg: "" };
      else if (p === 1) pen.bold = true;
      else if (p === 2) pen.dim = true;
      else if (p === 3) pen.italic = true;
      else if (p === 4) pen.underline = true;
      else if (p === 22) pen.bold = pen.dim = false;
      else if (p === 23) pen.italic = false;
      else if (p === 24) pen.underline = false;
      else if (p >= 30 && p <= 37) pen.fg = String(p - 30);
      else if (p >= 90 && p <= 97) pen.fg = String(p - 90 + 8);
      else if (p === 39) pen.fg = "";
      else if (p >= 40 && p <= 47) pen.bg = String(p - 40);
      else if (p >= 100 && p <= 107) pen.bg = String(p - 100 + 8);
      else if (p === 49) pen.bg = "";
      else if ((p === 38 || p === 48) && params[i + 1] === 5) {
        const c = String(params[i + 2] ?? 0);
        if (p === 38) pen.fg = c;
        else pen.bg = c;
        i += 2;
      } else if ((p === 38 || p === 48) && params[i + 1] === 2) {
        const c = "#" + hex(params[i + 2] ?? 0) + hex(params[i + 3] ?? 0) + hex(params[i + 4] ?? 0);
        if (p === 38) pen.fg = c;
        else pen.bg = c;
        i += 4;
      }
    }
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\x1b" && line[i + 1] === "[") {
      let j = i + 2;
      while (j < line.length && !/[@-~]/.test(line[j])) j++;
      if (line[j] === "m") {
        flush();
        sgr(line.slice(i + 2, j).split(";").filter((s) => s.length > 0).map(Number));
      }
      i = j + 1;
      continue;
    }
    if (ch === "\x1b" && line[i + 1] === "]") {
      // OSC (a hyperlink's start or end): up to BEL or ESC \.
      let j = i + 2;
      while (j < line.length && line[j] !== "\x07" && !(line[j] === "\x1b" && line[j + 1] === "\\")) j++;
      i = line[j] === "\x07" ? j + 1 : j + 2;
      continue;
    }
    if (ch === "\x1b") {
      i += 2;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
};

/** The status section's lines as specs (a list cell's segments share its index); the defaults for none. */
const parseLines = (section: unknown): { lines: Spec[][]; toolsLines: Spec[][]; separator: string } => {
  const spec = (item: unknown, cell: number): Spec | null => {
    const s: Spec = { segment: "", cell, fg: "", label: "", command: "", interval: 0 };
    if (typeof item === "string") return { ...s, segment: item };
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const f = item as Record<string, unknown>;
    s.segment = typeof f.segment === "string" ? f.segment : "";
    s.fg = typeof f.fg === "string" ? f.fg : "";
    s.label = typeof f.label === "string" ? f.label : "";
    s.command = typeof f.command === "string" ? f.command : "";
    s.interval = typeof f.interval === "number" ? f.interval : 0;
    if (s.segment.length === 0 && s.command.length === 0) s.segment = "?";
    return s;
  };
  const fromCells = (rows: unknown[][]): Spec[][] =>
    rows.map((cells) => {
      const specs: Spec[] = [];
      cells.forEach((item, i) => {
        for (const one of Array.isArray(item) ? item : [item]) {
          const s = spec(one, i);
          if (s !== null) specs.push(s);
        }
      });
      return specs;
    });
  const s = section !== null && typeof section === "object" ? (section as { lines?: unknown; toolsLines?: unknown; separator?: unknown }) : {};
  const separator = typeof s.separator === "string" ? s.separator : " │ ";
  const rows = (v: unknown): unknown[][] => (v as unknown[]).filter((l) => Array.isArray(l)) as unknown[][];
  const toolsLines = Array.isArray(s.toolsLines) ? fromCells(rows(s.toolsLines)) : fromCells(DEFAULT_TOOLS_LINES);
  if (!Array.isArray(s.lines)) return { lines: fromCells(DEFAULT_LINES), toolsLines, separator };
  const lines = fromCells(rows(s.lines));
  const shape = lines.map((l) => (l.every((x, i) => x.command === "" && x.fg === "" && x.label === "" && x.cell === i) ? l.map((x) => x.segment).join(" ") : "\u0000")).join("|");
  const untouched = shape === PREVIOUS_DEFAULT || PREVIOUS_LINES.includes(JSON.stringify(s.lines));
  return { lines: untouched ? fromCells(DEFAULT_LINES) : lines, toolsLines, separator };
};

/** The rows laid out `cells` wide: columns as wide as their widest non-last cell, rules lined up, the last cell clipped, right cells at the edge. */
const layout = (rows: (Cell[] | Run[])[], separator: string, cells: number): Run[][] => {
  const tableOf = (row: Cell[]): Cell[] => row.filter((c) => !c.right);
  const widths: number[] = [];
  for (const row of rows) {
    if (!isCells(row)) continue;
    const t = tableOf(row);
    for (let i = 0; i < t.length - 1; i++) widths[i] = Math.max(widths[i] ?? 0, runsWidth(t[i].runs));
  }
  const sep = width(separator);
  const used = (n: number): number => 1 + widths.slice(0, n).reduce((w, x) => w + (x > 0 ? x + sep : 0), 0);
  let shown = widths.length;
  while (shown > 1 && cells - used(shown) < TEXT_MIN) shown--;
  return rows.map((row) => {
    const line: Run[] = [run(" ", "")];
    if (!isCells(row)) return line.concat(row);
    const t = tableOf(row);
    let x = 1;
    let first = true;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      const last = i === t.length - 1;
      const w = runsWidth(c.runs);
      if (!last && ((widths[i] ?? 0) === 0 || i >= shown)) continue;
      if (last && w === 0) break;
      if (!first) {
        line.push(run(separator, DIM));
        x += sep;
      }
      first = false;
      c.x = x;
      const runs = last && w > cells - x ? clipRuns(c.runs, Math.max(0, cells - x)) : c.runs;
      line.push(...runs);
      c.w = last ? Math.min(w, Math.max(0, cells - x)) : widths[i];
      if (!last && widths[i] > w) line.push(run(" ".repeat(widths[i] - w), ""));
      x += c.w;
    }
    const right = row.filter((c) => c.right && c.runs.length > 0);
    if (right.length > 0) {
      const rw = right.reduce((s, c, i) => s + runsWidth(c.runs) + (i > 0 ? sep : 0), 0);
      const gap = Math.max(2, cells - 1 - x - rw);
      line.push(run(" ".repeat(gap), ""));
      x += gap;
      right.forEach((c, i) => {
        if (i > 0) {
          line.push(run(separator, DIM));
          x += sep;
        }
        c.x = x;
        c.w = runsWidth(c.runs);
        line.push(...c.runs);
        x += c.w;
      });
    }
    return line;
  });
};
const isCells = (row: Cell[] | Run[]): row is Cell[] => row.length === 0 || "names" in row[0];

lightcode.plugin({
  id: "status",
  defaults: () => ({
    separator: " │ ",
    lines: DEFAULT_LINES.map((l) => l.map((cell) => (cell.length === 1 ? cell[0] : cell))),
    toolsLines: DEFAULT_TOOLS_LINES.map((l) => l.map((cell) => (cell.length === 1 ? cell[0] : cell))),
  }),
  activate(api) {
    const { lines, toolsLines, separator } = parseLines(api.settings.section());
    const presses: Record<string, () => void> = {
      mode: () => {
        api.commands.run("/plan");
      },
      title: () => api.tell("/rename <title> renames the session · /title asks Claude for a new one"),
    };
    for (const name of Object.keys(SEGMENTS)) {
      const draw =
        name === "mode"
          ? (ctx: lightcode.SegmentContext): Run[] => {
              const approval = api.agent.approval();
              if (approval === "full") return [run("Full access", BAD)];
              if (approval === "plan") return [run("plan mode", WARN)];
              if (approval === "auto") return [run("auto", DIM)];
              return SEGMENTS.mode(ctx);
            }
          : SEGMENTS[name];
      api.ui.segment({ name, draw, press: presses[name] });
    }

    /** A table of `specs` on the band from column `under` through `to`: its commands, its rows, its strip. */
    const table = (specs: Spec[][], id: string, under: string, to: string, order: number): { refresh(): void; rerun(): void } => {
      // The user's commands: each run's lines kept until the next; a run at most every 300 ms, and every `interval` seconds when set.
      const commands = new Map<number, { spec: Spec; out: Run[][]; running: boolean; queued: boolean }>();
      specs.flat().forEach((s, i) => {
        if (s.command.length > 0) commands.set(i, { spec: s, out: [], running: false, queued: false });
      });
      let barWidth = 80;
      const runCommand = (c: { spec: Spec; out: Run[][]; running: boolean; queued: boolean }): void => {
        if (c.running || c.queued) return;
        c.queued = true;
        api.after(DEBOUNCE_MS, () => {
          c.queued = false;
          c.running = true;
          api.process
            .run("export COLUMNS=" + String(barWidth) + " LINES=3; " + c.spec.command, JSON.stringify(api.state.info()), COMMAND_MS)
            .then((r) => {
              c.out = r.timedOut
                ? [[run("⚠ status command took over " + String(COMMAND_MS / 1000) + " s", BAD)]]
                : r.code !== 0
                  ? [[run("⚠ status command exited " + String(r.code) + (r.err.trim().length > 0 ? ": " + r.err.trim().split("\n")[0].slice(0, 80) : ""), BAD)]]
                  : r.out.split("\n").slice(0, 16).map(parseAnsi);
              while (c.out.length > 0 && c.out[c.out.length - 1].length === 0) c.out.pop();
            })
            .finally(() => {
              c.running = false;
              band.refresh();
            });
        });
      };
      for (const c of commands.values()) {
        runCommand(c);
        if (c.spec.interval > 0) api.every(Math.max(1000, c.spec.interval * 1000), () => runCommand(c));
      }
      let rows: (Cell[] | Run[])[] = [];
      const draw = (cells: number): Run[][] => {
        const now = Date.now();
        const info = api.state.info();
        const ctx: lightcode.SegmentContext = { info, folderName: api.state.active().folderName, message: api.state.message(), note: api.state.note(), busy: api.agent.running(), spinner: T.spinner(now), now };
        let index = 0;
        rows = [];
        for (const line of specs) {
          const only = line.length === 1 ? line[0] : null;
          const command = only !== null && only.command.length > 0 ? commands.get(index) : undefined;
          if (command !== undefined) {
            // A line that is one command shows every line it printed.
            for (const l of command.out) rows.push(l);
            index += 1;
            continue;
          }
          const row: Cell[] = [];
          let right = false;
          let i = 0;
          while (i < line.length) {
            const cell = line[i].cell;
            const parts: Run[][] = [];
            const names: string[] = [];
            let spacer = false;
            while (i < line.length && line[i].cell === cell) {
              const s = line[i];
              const at = index;
              i++;
              index++;
              if (s.segment === "spacer") {
                spacer = true;
                continue;
              }
              let runs: Run[];
              if (s.command.length > 0) runs = (commands.get(at)?.out[0] ?? []).slice();
              else if (SEGMENTS[s.segment] !== undefined) runs = SEGMENTS[s.segment](ctx);
              else {
                const other = api.ui.drawSegment(s.segment, ctx);
                runs = other === null ? [run("?" + s.segment, BAD)] : other;
              }
              if (runs.length > 0) {
                const fg = safeColor(s.fg);
                if (fg.length > 0) runs = runs.map((r) => ({ ...r, fg }));
                if (s.label.length > 0) runs.unshift(run(s.label + " ", DIM));
              }
              parts.push(runs);
              names.push(s.command.length > 0 ? "command" : s.segment);
            }
            if (spacer) right = true;
            if (names.length === 0) continue;
            const runs: Run[] = [];
            for (const p of parts) {
              if (p.length === 0) continue;
              if (runs.length > 0) runs.push(run(" · ", DIM));
              runs.push(...p);
            }
            row.push({ runs, names, right, x: 0, w: 0 });
          }
          rows.push(row);
        }
        return layout(rows, separator, Math.max(20, cells - RIGHT_GAP));
      };
      const band = api.ui.band({
        id,
        under,
        to,
        order,
        lines: (cells) => {
          barWidth = cells;
          return draw(cells).map((runs) => ({ bg: T.band, runs }));
        },
        press: (row, x) => {
          const r = rows[row];
          if (r === undefined || !isCells(r)) return;
          const c = r.find((cell) => cell.w > 0 && x >= cell.x && x < cell.x + cell.w);
          if (c === undefined) return;
          for (const name of c.names) {
            const own = presses[name];
            if (own !== undefined) return own();
            if (api.ui.pressSegment(name)) return;
          }
        },
      });
      return {
        refresh: () => band.refresh(),
        rerun: () => {
          for (const c of commands.values()) runCommand(c);
        },
      };
    };
    const tables = [table(lines, "status", "chat", "tools", 0)];
    if (toolsLines.length > 0) tables.push(table(toolsLines, "tools-status", "tools", "", 10));
    // Redrawn as the session changes and every second (the clocks, the countdowns); the spinner is a live run the host moves on its own.
    api.every(1000, () => {
      for (const t of tables) t.refresh();
    });
    api.on("conversationChanged", () => {
      for (const t of tables) {
        t.refresh();
        t.rerun();
      }
    });
    api.on("messageChanged", () => {
      for (const t of tables) t.refresh();
    });
    api.on("approvalChanged", () => {
      for (const t of tables) t.refresh();
    });
  },
});

export {};
