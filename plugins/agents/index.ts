// The session's subagents: the Agents tab of the tools column, two rows each in the order they were called (● running,
// done, failed or interrupted, its kind and its task; then the tool it is using, or what it
// reported), its link's badge the number running. A press or Enter shows one's steps in the code
// column (Esc goes back to the file). The list follows the conversation, at most every 200 ms.

type Run = lightcode.Run;

const T = lightcode.theme;
const DIM = T.dim;
const SELECTED_BG = T.selected;
const MARKS: Record<string, string> = { running: T.warn, done: T.ok, failed: T.bad, interrupted: T.dim };
/** The list is read again at most this often as the conversation changes. */
const REFRESH_MS = 200;

lightcode.plugin({
  id: "agents",
  activate(api) {
    const u = lightcode.util;
    let agents: lightcode.Agent[] = [];
    let selected = 0;
    let pending = false;

    const read = (): void => {
      agents = api.agent.agents();
      if (selected >= agents.length) selected = Math.max(0, agents.length - 1);
      panel.refresh();
    };
    /** Read again soon: the conversation changes many times a second while Claude works. */
    const soon = (): void => {
      if (pending) return;
      pending = true;
      api.after(REFRESH_MS, () => {
        pending = false;
        read();
      });
    };

    const open = (at: number): void => {
      const a = agents[at];
      if (a === undefined) return;
      selected = at;
      panel.refresh();
      api.code.openAgent(a.id);
      api.actions.focus("code");
    };

    const running = (): number => agents.filter((a) => a.status === "running").length;

    const panel = api.ui.panel({
      id: "agents",
      title: "Agents",
      column: "tools",
      order: 2,
      width: (cols) => Math.max(32, Math.min(44, Math.floor(cols / 7))),
      count: () => (agents.length === 0 ? 1 : agents.length * 2),
      rows: (from, count, width) => {
        if (agents.length === 0) return from === 0 ? [{ runs: [{ text: " No subagents in this session.", fg: DIM }] }] : [];
        const out: lightcode.Row[] = [];
        for (let i = from; i < Math.min(from + count, agents.length * 2); i++) {
          const at = Math.floor(i / 2);
          const a = agents[at];
          const bg = at === selected ? SELECTED_BG : "";
          if (i % 2 === 0) {
            const title = (a.type.length > 0 ? a.type + " " : "") + a.description;
            const runs: Run[] = [
              { text: " ● ", fg: MARKS[a.status] ?? DIM },
              { text: u.clip(title.length > 0 ? title : "(no task)", Math.max(4, width - 4)), fg: "", bold: at === selected },
            ];
            out.push({ bg, runs });
          } else {
            const what = a.status === "running" ? (a.lastTool.length > 0 ? "↳ " + a.lastTool : "starting") : a.summary.replace(/\s+/g, " ").trim();
            const note = what.length > 0 ? a.status + " · " + what : a.status;
            out.push({ bg, runs: [{ text: "   " + u.clip(note, Math.max(4, width - 4)), fg: DIM }] });
          }
        }
        return out;
      },
      info: () => [{ text: " " + String(agents.length) + (agents.length === 1 ? " subagent" : " subagents") + (running() > 0 ? " · " + String(running()) + " running" : ""), fg: DIM }],
      badge: () => (running() > 0 ? [{ text: String(running()), fg: T.warn }] : agents.length > 0 ? [{ text: String(agents.length), fg: DIM }] : []),
      press: (row) => open(Math.floor(row / 2)),
      shown: () => {
        read();
        panel.reveal(selected * 2);
      },
    });

    api.on("conversationChanged", soon);
    const move = (step: number): boolean => {
      if (agents.length > 0) selected = Math.max(0, Math.min(agents.length - 1, selected + step));
      panel.reveal(selected * 2 + (step > 0 ? 1 : 0));
      panel.refresh();
      return true;
    };
    api.keys.action({ id: "agents.up", scope: "agents", help: "shows its steps", key: "up", run: () => move(-1) });
    api.keys.action({ id: "agents.down", scope: "agents", help: "shows its steps", key: "down", run: () => move(1) });
    api.keys.action({
      id: "agents.open",
      scope: "agents",
      help: "shows its steps",
      key: "enter",
      run: () => {
        open(selected);
        return true;
      },
    });
    read();
  },
});

export {};
