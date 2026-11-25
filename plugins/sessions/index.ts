// The folder's sessions with the agent: the Sessions tab (F4 or /resume shows it), two lines each,
// newest first (the title, ● for the chat's; when it was last used and how large it is). ↑↓ or a
// press choose one, and the code column shows it: when and where it ran, its model and cost, its
// first and last prompts, and the two ways to open it. Enter opens it here, in place of the chat's
// session; t opens it in a new terminal window (tmux, guake or the terminal found; "terminal" in
// the plugin's section or LIGHTCODE_TERMINAL names one, false turns it off); n starts a new
// session. Titles: the agent's own, else a short one Claude writes after a Claude Code session's
// first turn and for untitled ones as they are listed (at most 8 a listing), /rename to set one,
// /title to ask again; they are kept in the project's .lightcode/, and one the user gave is not
// replaced. The list is read again when a turn ends while the tab shows, and when the agent says
// it changed. Its section of config.json: { "titles": true, "titleModel": "haiku", "terminal": "" }.

type Run = lightcode.Run;

interface Listed extends lightcode.SessionSummary {
  /** The title shown: lightcode's, else Claude Code's, else the first prompt cut short. */
  title: string;
}

/** Untitled sessions a listing asks Claude to name, newest first. */
const T = lightcode.theme;
const TITLES_PER_LISTING = 8;
const DIM = T.dim;
const MINE = T.ok;
const SELECTED_BG = T.selected;

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return String(Math.floor(s / 60)) + " min ago";
  if (s < 86400) return String(Math.floor(s / 3600)) + " h ago";
  return String(Math.floor(s / 86400)) + " days ago";
};

const size = (bytes: number): string => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : String(Math.max(1, Math.round(bytes / 1024))) + " KB");

const untitled = (s: lightcode.SessionSummary): boolean => s.storedTitle.length === 0 && s.agentTitle.length === 0;

const pad2 = (n: number): string => (n < 10 ? "0" : "") + String(n);

/** When a session was last used: how long ago, and the local date and time. */
const when = (ms: number): string => {
  const d = new Date(ms);
  return ago(ms) + " · " + String(d.getFullYear()) + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
};

/** `s` quoted for sh. */
const q = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

/** The shell command that opens `run` (a command line) in a new window of terminal `term`, in folder `dir`. */
const launchIn = (term: string, run: string, dir: string): string => {
  const base = term.includes("/") ? term.slice(term.lastIndexOf("/") + 1) : term;
  if (base === "tmux") return "tmux new-window -c " + q(dir) + " " + q(run);
  if (base === "guake") return "guake -n " + q(dir) + " -e " + q(run);
  if (base === "gnome-terminal") return "gnome-terminal --working-directory=" + q(dir) + " -- sh -c " + q(run);
  if (base === "kitty") return "kitty --directory " + q(dir) + " sh -c " + q(run);
  if (base === "wezterm") return "wezterm start --cwd " + q(dir) + " -- sh -c " + q(run);
  if (base === "alacritty") return "alacritty --working-directory " + q(dir) + " -e sh -c " + q(run);
  if (base === "foot") return "foot -D " + q(dir) + " sh -c " + q(run);
  if (base === "konsole") return "konsole --workdir " + q(dir) + " -e sh -c " + q(run);
  return q(term) + " -e sh -c " + q("cd " + q(dir) + " && " + run);
};

/** A row of the session's details. */
interface InfoRow {
  row: lightcode.Row;
  /** What a press on it does: "open", "terminal" or nothing. */
  act: string;
}

lightcode.plugin({
  id: "sessions",
  defaults: () => ({ titles: true, titleModel: "haiku", terminal: "" }),
  activate(api) {
    const u = lightcode.util;
    const wrap = u.wrap;
    const settings = (api.settings.section() ?? {}) as { titles?: unknown; titleModel?: unknown; terminal?: unknown };
    api.titles.configure(settings.titles !== false, typeof settings.titleModel === "string" ? settings.titleModel : "");
    let list: Listed[] = [];
    let selected = 0;
    let current = api.agent.sessionId();
    /** The terminal a session opens in a new window of ("" for none). */
    let terminal = "";
    /** The width the details were last drawn at (their count depends on it). */
    let infoWidth = 80;
    /** How many there are, for the tab's link before the tab is first listed (no titles asked for). */
    let known = api.sessions.list().length;
    let wasRunning = false;
    let seenRev = api.sessions.rev();
    let seenAgent = api.agent.info().id;

    const titleOf = (s: lightcode.SessionSummary): string => {
      if (s.storedTitle.length > 0) return s.storedTitle;
      if (s.agentTitle.length > 0) return s.agentTitle;
      return u.clip(s.firstPrompt.replace(/\s+/g, " ").trim(), 50);
    };

    /** The list again, with their shown titles; Claude names a few untitled ones meanwhile. */
    const refresh = (): void => {
      let asked = 0;
      list = api.sessions.list().map((s) => {
        if (asked < TITLES_PER_LISTING && untitled(s) && api.titles.request(s.id, s.firstPrompt, "")) asked++;
        return { ...s, title: titleOf(s) };
      });
      if (selected >= list.length) selected = 0;
      current = api.agent.sessionId();
      panel.refresh();
    };

    const resume = (s: Listed | undefined): void => {
      if (s === undefined) return;
      if (info.shown()) api.code.open(api.code.path());
      api.agent.resume(s.id, s.title);
      if (untitled(s)) api.titles.request(s.id, s.firstPrompt, "");
      api.chat.showChat();
      api.actions.focus("chat");
      api.tell("resumed " + (s.title.length > 0 ? u.clip(s.title.replace(/\s+/g, " "), 40) : s.id));
    };

    /** The session's details, as rows `width` cells wide: the facts, the prompts, the ways to open it. */
    const infoRows = (width: number): InfoRow[] => {
      const s = list[selected];
      const out: InfoRow[] = [];
      if (s === undefined) return [{ row: { runs: [{ text: " No session chosen.", fg: DIM }] }, act: "" }];
      const w = Math.max(20, width - 2);
      const line = (text: string, fg: string, bold: boolean, act: string): void => {
        out.push({ row: { runs: [{ text: " " + text, fg, bold }] }, act });
      };
      const field = (name: string, value: string): void => {
        if (value.length === 0) return;
        const parts = wrap(value, Math.max(10, w - 9));
        for (let i = 0; i < parts.length; i++) out.push({ row: { runs: [{ text: " " + (i === 0 ? name + " ".repeat(Math.max(0, 8 - name.length)) : "        "), fg: DIM }, { text: parts[i] }] }, act: "" });
      };
      const kept = api.store.session(s.id);
      line(s.title.length > 0 ? s.title : "(untitled)", "", true, "");
      line("", "", false, "");
      field("when", when(s.mtimeMs));
      field("size", s.size > 0 ? size(s.size) : "");
      field("folder", s.cwd);
      field("model", kept !== null && kept.model.length > 0 ? kept.model + (kept.effort.length > 0 ? " · " + kept.effort : "") : s.model);
      field("cost", kept !== null && kept.costUsd > 0 ? "$" + kept.costUsd.toFixed(2) : "");
      field("id", s.id);
      if (s.firstPrompt.length > 0) {
        line("", "", false, "");
        line("First prompt", DIM, false, "");
        for (const part of wrap(s.firstPrompt, w)) line(part, "", false, "");
      }
      if (s.lastPrompt.length > 0 && s.lastPrompt !== s.firstPrompt) {
        line("", "", false, "");
        line("Last prompt", DIM, false, "");
        for (const part of wrap(s.lastPrompt, w)) line(part, "", false, "");
      }
      line("", "", false, "");
      if (s.id === current) line("● the chat has this session open", MINE, false, "");
      else {
        line("› Enter  open it here, in place of the chat's session", "", false, "open");
        if (terminal.length > 0) line("› t      open it in a new terminal", "", false, "terminal");
        else line("  no terminal to open it in: name one as \"terminal\" in the plugin's section of config.json, or LIGHTCODE_TERMINAL", DIM, false, "");
      }
      return out;
    };

    const info = api.code.view({
      id: "session",
      count: () => infoRows(infoWidth).length,
      rows: (from, count, width) => {
        infoWidth = width;
        return infoRows(width).slice(from, from + count).map((r) => r.row);
      },
      press: (row) => {
        const r = infoRows(infoWidth)[row];
        if (r === undefined) return;
        if (r.act === "open") resume(list[selected]);
        else if (r.act === "terminal") openTerminal(list[selected]);
      },
    });

    /** The chosen session's details in the code column. */
    const showInfo = (): void => {
      const s = list[selected];
      info.show("Session · " + (s === undefined ? "none" : s.title.length > 0 ? u.clip(s.title.replace(/\s+/g, " "), 60) : "(untitled)"));
    };

    /** Open `s` in a new terminal window running lightcode on it. */
    const openTerminal = (s: Listed | undefined): void => {
      if (s === undefined) return;
      if (terminal.length === 0) return api.tell("no terminal to open it in: set \"terminal\" in the plugin's section of config.json, or LIGHTCODE_TERMINAL");
      if (s.id === current) return api.tell("the chat has this session open");
      const dir = s.cwd.length > 0 ? s.cwd : api.fs.env("PWD");
      const argv = [api.fs.executable(), "--dir", dir];
      const agent = api.agent.info().id;
      if (agent !== "claude") argv.push("--agent", agent);
      argv.push("--resume", s.id);
      const run = argv.map(q).join(" ");
      const launch = launchIn(terminal, run, dir) + " </dev/null >/dev/null 2>&1";
      const command = "if command -v setsid >/dev/null 2>&1; then setsid -f " + launch + "; else (" + launch + " &); fi";
      api.process.run(command, "", 5000).then((r) => {
        if (r.code === 0) api.tell("opened in a new " + (terminal.includes("/") ? terminal.slice(terminal.lastIndexOf("/") + 1) : terminal) + " window: " + (s.title.length > 0 ? u.clip(s.title.replace(/\s+/g, " "), 40) : s.id));
        else api.tell("could not open a terminal (" + String(r.code) + "): " + (r.err.trim().length > 0 ? u.clip(r.err.trim(), 80) : command));
        api.note("terminal: " + command + " -> " + String(r.code) + " " + r.err.trim());
      });
    };

    /** The terminal sessions open in: the one named in the section or LIGHTCODE_TERMINAL, tmux or guake when inside them, else the first found on a display. */
    const findTerminal = (): void => {
      const chosen = settings.terminal;
      if (chosen === false || chosen === "none") return;
      if (typeof chosen === "string" && chosen.length > 0) {
        terminal = chosen;
        return;
      }
      const named = api.fs.env("LIGHTCODE_TERMINAL");
      if (named.length > 0) {
        terminal = named;
        return;
      }
      if (api.fs.env("TMUX").length > 0) {
        terminal = "tmux";
        return;
      }
      if (api.fs.env("GUAKE_TAB_UUID").length > 0) {
        terminal = "guake";
        return;
      }
      if (api.fs.env("DISPLAY").length === 0 && api.fs.env("WAYLAND_DISPLAY").length === 0) return;
      const preferred = api.fs.env("TERMINAL");
      api.process.run("command -v " + (preferred.length > 0 ? q(preferred) + " " : "") + "x-terminal-emulator gnome-terminal kitty alacritty wezterm foot konsole xterm 2>/dev/null | head -n 1", "", 2000).then((r) => {
        const found = r.out.trim().split("\n")[0] ?? "";
        if (found.length === 0) return;
        terminal = found;
        if (info.shown()) info.refresh();
      });
    };
    findTerminal();

    const panel = api.ui.panel({
      id: "sessions",
      title: "Sessions",
      order: 1,
      width: (cols) => Math.max(24, Math.min(48, Math.floor(cols / 6))),
      count: () => (list.length === 0 ? 1 : list.length * 2),
      rows: (from, count, width) => {
        const out: lightcode.Row[] = [];
        if (list.length === 0) return from === 0 ? [{ runs: [{ text: " No sessions yet here.", fg: DIM }] }] : [];
        for (let i = from; i < Math.min(from + count, list.length * 2); i++) {
          const at = Math.floor(i / 2);
          const s = list[at];
          const bg = at === selected ? SELECTED_BG : "";
          if (i % 2 === 0) {
            const mine = s.id === current;
            const runs: Run[] = [
              { text: mine ? " ● " : "   ", fg: MINE },
              { text: u.clip((s.title.length > 0 ? s.title : "(untitled)").replace(/\s+/g, " "), Math.max(4, width - 4)), fg: mine ? MINE : "", bold: at === selected || mine },
            ];
            out.push({ bg, runs });
          } else out.push({ bg, runs: [{ text: "   " + u.clip(ago(s.mtimeMs) + (s.size > 0 ? " · " + size(s.size) : ""), Math.max(4, width - 4)), fg: DIM }] });
        }
        return out;
      },
      badge: () => {
        const n = Math.max(known, list.length);
        return n > 0 ? [{ text: String(n), fg: T.dim }] : [];
      },
      info: () => [{ text: " " + String(list.length) + (list.length === 1 ? " session" : " sessions") + " · n new", fg: DIM }],
      press: (row) => {
        selected = Math.floor(row / 2);
        panel.refresh();
        showInfo();
      },
      shown: () => {
        refresh();
        panel.reveal(selected * 2);
        showInfo();
      },
      hidden: () => {
        if (info.shown()) api.code.open(api.code.path());
      },
    });

    api.titles.onTitle((id, title) => {
      const kept = api.store.session(id);
      if (kept !== null && kept.titleBy === "user") return;
      api.store.updateSession(id, { title, titleBy: "claude" });
      api.note("title " + id + ": " + title);
      if (api.agent.sessionId() === id) api.agent.setTitle(title);
      for (const s of list)
        if (s.id === id) {
          s.storedTitle = title;
          s.title = title;
        }
      panel.refresh();
    });

    api.on("sessionsChanged", () => {
      // A record landed (a title, a cost, the model): the list's titles and details follow it.
      if (api.state.active().panel === "sessions") refresh();
      else panel.refresh();
    });
    api.on("conversationChanged", () => {
      const running = api.agent.running();
      const rev = api.sessions.rev();
      const agent = api.agent.info().id;
      const shown = api.state.active().panel === "sessions";
      if (agent !== seenAgent) {
        // Another agent: its own sessions.
        seenAgent = agent;
        list = [];
        selected = 0;
        if (shown) refresh();
        else known = api.sessions.list().length;
        panel.refresh();
      } else if (((wasRunning && !running) || rev !== seenRev) && shown) refresh();
      // A turn ended (the list may hold a new session, or a changed one), or the agent said its list
      // changed (another agent's is read in the background).
      else if (rev !== seenRev) {
        known = api.sessions.list().length;
        panel.refresh();
      }
      wasRunning = running;
      seenRev = api.sessions.rev();
      const id = api.agent.sessionId();
      if (id !== current) {
        current = id;
        panel.refresh();
      }
    });

    api.commands.add({ name: "/resume", help: "the folder's sessions (also F4)", run: () => api.actions.showPanel("sessions") });
    api.commands.add({
      name: "/rename",
      usage: "<title>",
      help: "name this session",
      run: (title) => {
        if (title.length === 0) return api.tell("/rename <title>");
        const id = api.agent.sessionId();
        if (id.length === 0) return api.tell("send a message first: the session has no id yet");
        api.store.updateSession(id, { title, titleBy: "user" });
        api.agent.setTitle(title);
        api.tell("renamed: " + title);
      },
    });
    api.commands.add({
      name: "/title",
      help: "ask Claude for a new title",
      run: () => {
        if (api.agent.info().id !== "claude") return api.tell(api.agent.info().name + " titles its own sessions");
        const id = api.agent.sessionId();
        const first = api.agent.firstExchange();
        if (id.length === 0 || !api.titles.request(id, first.prompt, first.reply, true)) api.tell("nothing to name yet");
        else api.tell("asking Claude for a title");
      },
    });
    api.keys.action({
      id: "sessions.toggle",
      key: "f4",
      run: () => {
        const a = api.state.active();
        if (a.panel === "sessions" && a.column === "side") {
          const ids = api.state.panels();
          api.actions.showPanel(ids[0] === "sessions" && ids.length > 1 ? ids[1] : ids[0]);
        } else api.actions.showPanel("sessions");
        return true;
      },
    });
    const move = (step: number): boolean => {
      const n = list.length;
      if (n > 0) selected = Math.max(0, Math.min(n - 1, selected + step));
      panel.reveal(selected * 2 + (step > 0 ? 1 : 0));
      panel.refresh();
      showInfo();
      return true;
    };
    api.keys.action({ id: "sessions.up", scope: "sessions", help: "shows", key: "up", run: () => move(-1) });
    api.keys.action({ id: "sessions.down", scope: "sessions", help: "shows", key: "down", run: () => move(1) });
    api.keys.action({
      id: "sessions.resume",
      scope: "sessions",
      help: "opens here",
      key: "enter",
      run: () => {
        resume(list[selected]);
        return true;
      },
    });
    api.keys.action({
      id: "sessions.terminal",
      scope: "sessions",
      help: "new terminal",
      key: "char:t",
      run: () => {
        openTerminal(list[selected]);
        return true;
      },
    });
    api.keys.action({
      id: "sessions.new",
      scope: "sessions",
      help: "new",
      key: "char:n",
      run: () => {
        api.commands.run("/new");
        return true;
      },
    });
  },
});

export {};
