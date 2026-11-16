// The skills the agent has, in the Skills tab of the files column, and the way to call one: the
// skills as the agent's plugin said them (the project's and the user's read from disk at launch,
// Claude Code's own once it starts, an ACP agent's from its entry's skills command), grouped by
// where each comes from (the project's, the user's, a
// plugin's, the agent's own), each with what its SKILL.md says it is for and how many times it ran
// this session; above them the session's skill runs, newest first (● running, done or failed, the
// calls the turn made after the skill and for how long), live while one runs. ↑↓ choose, Enter or
// a press on a skill shows its SKILL.md in the code column, rendered as the chat renders markdown
// (a page about a bundled skill, which has none), and puts what calls it in the
// composer ("/name " for Claude Code; "Use the name skill: " for an agent whose skills are asked
// for in words), ready for arguments and Enter; `v` goes to the file alone; Enter on a run shows
// the call that loaded the skill. A run that ended is kept in the project's records, so each
// skill's row also says how many times it ran there across sessions, and a press says how many of
// those the user typed and how many the agent chose. Each skill Claude Code calls
// by a slash is a command here too, so the strip above the composer completes it with its
// description as "/" is typed; /skills shows the tab.

type Run = widecode.Run;

const T = widecode.theme;
const DIM = T.dim;
const SELECTED_BG = T.selected;
const MARKS: Record<string, string> = { running: T.warn, done: T.ok, failed: T.bad, stopped: T.dim };
/** The list is read again at most this often as the conversation changes. */
const REFRESH_MS = 200;
/** The sources' order: the project's first, then the user's, then each plugin's by name, then the agent's own. */
const SOURCE_RANK: Record<string, number> = { project: 0, user: 1, "built-in": 3 };

type Skill = { name: string; description: string; source: string; path: string; command: string };
type SkillRun = { name: string; callId: string; state: string; startedMs: number; endedMs: number; calls: number };
type Usage = { name: string; runs: number; typed: number; failed: number; lastMs: number };

/** A row of the tab: a group's header, a run, a skill, or a line of words. */
interface Line {
  kind: "head" | "run" | "skill" | "note";
  text: string;
  note: string;
  noteFg: string;
  /** The skill or run the row stands for (null for a header or a note). */
  skill: Skill | null;
  run: SkillRun | null;
}

const sourceRank = (source: string): number => SOURCE_RANK[source] ?? 2;

widecode.plugin({
  id: "skills",
  activate(api) {
    const u = widecode.util;
    let lines: Line[] = [];
    let skills: Skill[] = [];
    let runs: SkillRun[] = [];
    let known = false;
    /** The list is what the agent's plugin found on disk, before the agent said. */
    let partial = false;
    let selected = -1;
    let pending = false;
    /** The skill commands this plugin registered, by name, and the list they were made from. */
    let registered: string[] = [];
    let registeredFrom = "";
    /** Each skill's runs across the project's sessions, and the ended runs kept this process (session and run). */
    let usage = new Map<string, Usage>();
    const kept = new Set<string>();

    const agentName = (): string => api.agent.info().name;
    const running = (): number => runs.filter((r) => r.state === "running").length;
    /** What calling `s` from the composer is: its command and a space, else a sentence to finish. */
    const callText = (s: Skill): string => (s.command.length > 0 ? s.command + " " : "Use the " + s.name + " skill: ");

    /** The skill commands follow the list: one per skill called by a slash whose name no other plugin owns; those gone are dropped. */
    const syncCommands = (): void => {
      const from = skills.map((s) => s.command + "\t" + s.description).join("\n");
      if (from === registeredFrom) return;
      registeredFrom = from;
      const owners = new Map<string, string>();
      for (const c of api.state.commands()) owners.set(c.name, c.owner);
      const wanted = skills.filter((s) => s.command.startsWith("/") && (owners.get(s.command) ?? api.id) === api.id);
      for (const name of registered) if (!wanted.some((s) => s.command === name)) api.commands.remove(name);
      for (const s of wanted) {
        if (registered.includes(s.command)) continue;
        const command = s.command;
        api.commands.add({
          name: command,
          usage: "[args]",
          help: s.description.length > 0 ? s.description : "a skill of " + agentName(),
          run: (arg) => {
            const r = api.agent.send(command + (arg.length > 0 ? " " + arg : ""));
            if (r.error.length > 0) api.tell(r.error);
          },
        });
      }
      registered = wanted.map((s) => s.command);
    };

    const rebuild = (): void => {
      const out: Line[] = [];
      const name = agentName();
      if (!known) out.push({ kind: "note", text: "Known once " + name + " starts.", note: "", noteFg: "", skill: null, run: null });
      else {
        if (runs.length > 0) {
          const on = running();
          out.push({ kind: "head", text: "Runs", note: on > 0 ? String(on) + " running" : "", noteFg: T.warn, skill: null, run: null });
          for (let i = runs.length - 1; i >= 0; i--) out.push({ kind: "run", text: runs[i].name, note: "", noteFg: DIM, skill: null, run: runs[i] });
        }
        if (skills.length === 0 && !partial) out.push({ kind: "head", text: name, note: "lists no skills", noteFg: DIM, skill: null, run: null });
        const sources: string[] = [];
        for (const s of skills) if (!sources.includes(s.source)) sources.push(s.source);
        sources.sort((a, b) => sourceRank(a) - sourceRank(b) || a.localeCompare(b));
        for (const source of sources) {
          out.push({ kind: "head", text: source.length > 0 ? source : name, note: "", noteFg: DIM, skill: null, run: null });
          for (const s of skills) if (s.source === source) out.push({ kind: "skill", text: s.name, note: s.description, noteFg: DIM, skill: s, run: null });
        }
        if (partial) out.push({ kind: "note", text: "More once " + name + " starts.", note: "", noteFg: "", skill: null, run: null });
      }
      lines = out;
      if (selected >= lines.length || (selected >= 0 && lines[selected].skill === null && lines[selected].run === null)) selected = -1;
    };

    const read = (): void => {
      const got = api.agent.skills();
      known = got.known;
      partial = got.partial;
      skills = got.skills;
      runs = got.runs;
      keep();
      syncCommands();
      rebuild();
      panel.refresh();
    };
    /** Each run that ended goes into the project's records once, then the totals are read again. */
    const keep = (): void => {
      const session = api.agent.sessionId();
      if (session.length > 0)
        for (const r of runs) {
          if (r.state === "running") continue;
          const key = session + ":" + (r.callId.length > 0 ? r.callId : "typed:" + String(r.startedMs)) + ":" + r.state;
          if (kept.has(key)) continue;
          if (api.store.saveSkillRun({ skill: r.name, callId: r.callId, state: r.state, startedMs: r.startedMs, endedMs: r.endedMs, calls: r.calls })) kept.add(key);
        }
      usage = new Map(api.store.skillUsage().map((x) => [x.name, x]));
    };

    /** What the project's records say of skill `name`: its runs, typed and chosen, and the last ("" for none). */
    const usageNote = (name: string): string => {
      const x = usage.get(name);
      if (x === undefined || x.runs === 0) return "not run in this project yet";
      const parts = [String(x.runs) + (x.runs === 1 ? " run" : " runs") + " in this project", String(x.typed) + " typed", String(x.runs - x.typed) + " chosen by the agent"];
      if (x.failed > 0) parts.push(String(x.failed) + " failed");
      if (x.lastMs > 0) parts.push("last " + u.elapsed(Math.max(0, Date.now() - x.lastMs)) + " ago");
      return parts.join(" · ");
    };

    /** Read again soon: the conversation changes many times a second while the agent works. */
    const soon = (): void => {
      if (pending) return;
      pending = true;
      api.after(REFRESH_MS, () => {
        pending = false;
        read();
      });
    };

    /** The run's second part: where it stands, the calls after the skill, and how long it has taken or took. */
    const runNote = (r: SkillRun, now: number): string => {
      const ms = r.startedMs > 0 ? (r.endedMs > 0 ? r.endedMs : now) - r.startedMs : -1;
      const parts = [r.state, String(r.calls) + (r.calls === 1 ? " call" : " calls")];
      if (ms >= 0) parts.push(u.elapsed(ms));
      if (r.callId.length === 0) parts.push("typed");
      return parts.join(" · ");
    };

    /** Put what calls the skill in the composer, the caret after it, and say what Enter does (and that a bundled skill has no file to show). */
    const compose = (s: Skill): void => {
      const text = callText(s);
      api.composer.set([text], 0, u.graphemes(text).length);
      api.actions.focus("chat");
      api.tell((s.command.length > 0 ? "Enter sends " + s.command + " to " + agentName() : "say what " + s.name + " should do, then Enter") + " · " + usageNote(s.name));
    };

    /** A SKILL.md without its frontmatter (the name and description between the first two `---` lines, which the tab shows already). */
    const body = (text: string): string => {
      if (!text.startsWith("---")) return text;
      const end = text.indexOf("\n---", 3);
      return end < 0 ? text : text.slice(end + 4).replace(/^\s*\n/, "");
    };
    /** Show the skill's SKILL.md in the code column, rendered as the chat renders markdown (a page about a bundled skill, which has none); false when its file cannot be read. */
    const view = (s: Skill): boolean => {
      const name = agentName();
      if (s.path.length === 0) {
        const page = ["# " + s.name, "", "Built into " + name + ": no file to show."];
        if (s.description.length > 0) page.push("", s.description);
        page.push("", s.command.length > 0 ? "`" + s.command + "` in the composer calls it." : "Ask " + name + " for it in words.");
        api.code.markdown(s.name + " · built into " + name, page.join("\n"));
        return true;
      }
      const text = api.fs.text(s.path);
      if (text === null) {
        api.tell("cannot read " + s.path);
        return false;
      }
      const relative = api.actions.relative(s.path);
      api.code.markdown(s.name + " · " + (relative.length > 0 ? relative : s.path), body(text));
      return true;
    };

    const act = (at: number): void => {
      const l = lines[at];
      if (l === undefined) return;
      if (l.skill !== null) {
        selected = at;
        panel.refresh();
        view(l.skill);
        compose(l.skill);
      } else if (l.run !== null) {
        selected = at;
        panel.refresh();
        if (l.run.callId.length > 0) {
          api.code.openCall(l.run.callId);
          api.actions.focus("code");
        } else api.tell(l.run.name + " was typed as a command: " + runNote(l.run, Date.now()));
      }
    };

    const panel = api.ui.panel({
      id: "skills",
      title: "Skills",
      order: 4,
      width: (cols) => Math.max(32, Math.min(48, Math.floor(cols / 6))),
      count: () => lines.length,
      rows: (from, n, width) => {
        const out: widecode.Row[] = [];
        const now = Date.now();
        for (let i = from; i < Math.min(from + n, lines.length); i++) {
          const l = lines[i];
          const bg = i === selected ? SELECTED_BG : "";
          if (l.kind === "run" && l.run !== null) {
            const r = l.run;
            const mark: Run = { text: "● ", fg: MARKS[r.state] ?? DIM };
            if (r.state === "running") mark.live = "spinner";
            const cells: Run[] = [{ text: " " }, mark, { text: u.clip(r.name, Math.max(4, Math.floor(width / 2))), bold: i === selected }];
            const left = width - u.runsWidth(cells) - 2;
            if (left > 3) cells.push({ text: "  " + u.clip(runNote(r, now), left), fg: DIM });
            out.push({ bg, runs: cells });
            continue;
          }
          // A skill's runs at the row's end (this session's, then the project's in all), then the name, then its description in what is left.
          const times = l.skill !== null ? runs.filter((r) => r.name === l.text).length : 0;
          const total = l.skill !== null ? (usage.get(l.text)?.runs ?? 0) : 0;
          const tail = (times > 0 ? "×" + String(times) + (total > 0 ? " · " : "") : "") + (total > 0 ? String(total) + (total === 1 ? " run" : " runs") : "");
          const room = width - (tail.length > 0 ? tail.length + 2 : 0);
          const cells: Run[] = [{ text: (l.kind === "head" ? " " : "   ") + u.clip(l.text, Math.max(4, room - 4)), fg: l.kind === "note" ? DIM : "", bold: l.kind === "head" || i === selected }];
          const left = room - u.runsWidth(cells) - 2;
          if (l.note.length > 0 && left > 3) cells.push({ text: "  " + u.clip(l.note, left), fg: l.noteFg });
          if (tail.length > 0) {
            u.pad(cells, width - tail.length - 1);
            cells.push({ text: tail, fg: DIM });
          }
          out.push({ bg, runs: cells });
        }
        return out;
      },
      info: () => [{ text: " " + String(skills.length) + (skills.length === 1 ? " skill" : " skills") + (runs.length > 0 ? " · " + String(runs.length) + (runs.length === 1 ? " run" : " runs") : "") + (running() > 0 ? " · " + String(running()) + " running" : ""), fg: DIM }],
      badge: () => (running() > 0 ? [{ text: String(running()), fg: T.warn }] : skills.length > 0 ? [{ text: String(skills.length), fg: DIM }] : []),
      press: (row) => act(row),
      shown: () => {
        read();
        if (selected >= 0) panel.reveal(selected);
      },
    });

    /** Move the selection to the next (or previous) skill or run. */
    const move = (step: number): boolean => {
      let at = selected;
      for (let i = 0; i < lines.length; i++) {
        at += step;
        if (at < 0 || at >= lines.length) break;
        if (lines[at].skill !== null || lines[at].run !== null) {
          selected = at;
          break;
        }
      }
      if (selected >= 0) panel.reveal(selected);
      panel.refresh();
      return true;
    };
    api.keys.action({ id: "skills.up", scope: "skills", help: "Enter calls", key: "up", run: () => move(-1) });
    api.keys.action({ id: "skills.down", scope: "skills", help: "Enter calls", key: "down", run: () => move(1) });
    api.keys.action({
      id: "skills.call",
      scope: "skills",
      help: "Enter calls",
      key: "enter",
      run: () => {
        if (selected < 0) return false;
        act(selected);
        return true;
      },
    });
    api.keys.action({
      id: "skills.view",
      scope: "skills",
      help: "goes to its file",
      key: "char:v",
      run: () => {
        const l = selected >= 0 ? lines[selected] : undefined;
        if (l === undefined || l.skill === null) return false;
        if (view(l.skill)) api.actions.focus("code");
        return true;
      },
    });
    api.commands.add({
      name: "/skills",
      help: "the agent's skills, in the Skills tab",
      run: () => {
        read();
        api.actions.showPanel("skills");
        api.actions.focus("side");
        api.tell(known ? String(skills.length) + (skills.length === 1 ? " skill" : " skills") + " of " + agentName() + (skills.some((s) => s.command.length > 0) ? ": type / in the composer to complete one" : ": ask for one in words") : "known once " + agentName() + " starts");
      },
    });

    api.on("conversationChanged", soon);
    // The clocks of the runs in progress.
    api.every(1000, () => {
      if (running() > 0) panel.refresh();
    });
    read();
  },
});

export {};
