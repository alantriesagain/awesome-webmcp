// The Tools tab of the tools column beside the chat: Claude's tool calls under the message each
// answers, each with where it stands and its clock, drawn by the core's tools widget. A press or
// Enter shows a call whole in the code column; the chat's "· N tools" lines show their calls here.
// Beside it the Available tab: the tools the agent has, its own first, then each MCP server's
// (widecode's own tools among them) with where the server stands, as the agent's plugin says; a
// tool the mode denies, limits or asks for says so, and one called says how many times; a press on
// a tool says all of it in the status bar.

type Run = widecode.Run;

const T = widecode.theme;
const DIM = T.dim;
const STATUS: Record<string, string> = { pending: T.warn, failed: T.bad, "needs-auth": T.warn };
/** The list is read again at most this often as the conversation changes. */
const REFRESH_MS = 200;

/** A row of the Available tab: a group's header (its tools' source, bold) or one tool (and its source), a note after it, and a tool's calls this session. */
interface Line {
  head: boolean;
  text: string;
  source: string;
  fg: string;
  note: string;
  noteFg: string;
  calls: number;
}

/** What the mode lets a tool do, as its row says it. */
const accessNote = (t: { access: string; scope: string }): string => (t.access === "denied" ? "denied" : t.access === "asks" ? "asks" : t.access === "limited" ? "only " + t.scope : "");

widecode.plugin({
  id: "tools",
  activate(api) {
    api.widgets.tools({ title: "Tools", order: 0 });

    const u = widecode.util;
    let lines: Line[] = [];
    let count = 0;
    let used = 0;
    let pending = false;

    /** The agent's tools as groups: its own, then each MCP server's, a server without tools (yet) a header alone. */
    const read = (): void => {
      const got = api.agent.tools();
      const name = api.agent.info().name;
      const out: Line[] = [];
      // The servers the agent was given, and any a tool names that it did not list.
      const sources = got.servers.map((s) => s.name);
      for (const t of got.tools) if (t.server.length > 0 && !sources.includes(t.server)) sources.push(t.server);
      const tool = (t: (typeof got.tools)[number]): Line => ({ head: false, text: t.name, source: t.server.length > 0 ? t.server : name, fg: t.access === "denied" ? DIM : "", note: accessNote(t), noteFg: t.access === "denied" ? T.bad : T.warn, calls: t.calls });
      if (!got.known) out.push({ head: false, text: "Known once " + name + " starts.", source: "", fg: DIM, note: "", noteFg: "", calls: 0 });
      else {
        out.push({ head: true, text: name, source: "", fg: "", note: got.ownKnown ? "" : "lists none of its own", noteFg: DIM, calls: 0 });
        for (const t of got.tools) if (t.server.length === 0) out.push(tool(t));
        for (const server of sources) {
          const status = got.servers.find((s) => s.name === server)?.status ?? "";
          out.push({ head: true, text: server, source: "", fg: "", note: "MCP" + (status.length > 0 && status !== "connected" ? " · " + status : ""), noteFg: STATUS[status] ?? DIM, calls: 0 });
          for (const t of got.tools) if (t.server === server) out.push(tool(t));
        }
        // The programs the session's commands ran, most run first.
        if (got.programs.length > 0) {
          out.push({ head: true, text: "Programs", source: "", fg: "", note: "", noteFg: DIM, calls: 0 });
          for (const p of got.programs) out.push({ head: false, text: p.program, source: "", fg: "", note: "", noteFg: "", calls: p.calls });
        }
      }
      lines = out;
      count = got.tools.length;
      used = got.tools.filter((t) => t.calls > 0).length;
      panel.refresh();
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

    const panel = api.ui.panel({
      id: "available",
      title: "Available",
      column: "tools",
      order: 1,
      width: (cols) => Math.max(32, Math.min(44, Math.floor(cols / 7))),
      count: () => lines.length,
      rows: (from, n, width) => {
        const out: widecode.Row[] = [];
        for (const l of lines.slice(from, from + n)) {
          // Its calls at the row's end, then the name, then the note in what is left.
          const calls = l.calls > 0 ? "×" + String(l.calls) : "";
          const room = width - (calls.length > 0 ? calls.length + 2 : 0);
          const runs: Run[] = [{ text: (l.head ? " " : "   ") + u.clip(l.text, Math.max(4, room - 4)), fg: l.fg, bold: l.head }];
          const left = room - u.runsWidth(runs) - 2;
          if (l.note.length > 0 && left > 3) runs.push({ text: "  " + u.clip(l.note, left), fg: l.noteFg });
          if (calls.length > 0) {
            u.pad(runs, width - calls.length - 1);
            runs.push({ text: calls, fg: DIM });
          }
          out.push({ runs });
        }
        return out;
      },
      info: () => [{ text: " " + String(count) + (count === 1 ? " tool" : " tools") + (used > 0 ? " · " + String(used) + " used" : ""), fg: DIM }],
      badge: () => (count > 0 ? [{ text: String(count), fg: DIM }] : []),
      press: (row) => {
        const l = lines[row];
        if (l === undefined || l.head || l.source.length === 0) return;
        api.tell(l.text + " (" + l.source + ")" + (l.note.length > 0 ? ": " + l.note : "") + (l.calls > 0 ? " · called " + String(l.calls) + (l.calls === 1 ? " time" : " times") + " this session" : ""));
      },
      shown: () => read(),
    });

    api.on("conversationChanged", soon);
    read();
  },
});

export {};
