// Which tools the model is offered: `/tools` lists them with their state, `/tools off <name>` and
// `/tools on <name>` switch one, and `/tools reset` turns every one on. The choice is kept as a
// custom entry (`tools-switch`, `{ active }`), so a session loaded again restores it from the latest
// such entry on its branch.

const recordOf = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** The names a custom entry's data lists as its active tools, null when it lists none. */
const activeOnBranch = (branch: unknown[]): string[] | null => {
  let found: string[] | null = null;
  for (const value of branch) {
    const entry = recordOf(value);
    if (entry === null || entry["type"] !== "custom" || entry["customType"] !== "tools-switch") continue;
    const data = recordOf(entry["data"]);
    if (data === null || !Array.isArray(data["active"])) continue;
    const names: string[] = [];
    for (const v of data["active"] as unknown[]) names.push(String(v));
    found = names;
  }
  return found;
};

/** The tools as lines, each said on or off. */
const listed = (agent: lightcode.AgentApi): string => {
  const active = agent.getActiveTools();
  const tools = agent.getAllTools();
  if (tools.length === 0) return "No tools.";
  const lines: string[] = [];
  for (const t of tools) lines.push(t.name + ": " + (active.includes(t.name) ? "on" : "off"));
  return lines.join("\n");
};

lightcode.plugin({
  id: "tools-switch",
  agent(agent) {
    agent.on("session_start", (_event, ctx) => {
      const names = activeOnBranch(ctx.sessionManager.getBranch());
      if (names !== null) agent.setActiveTools(names);
    });

    agent.registerCommand("tools", {
      description: "List the tools, or switch one off or on",
      handler(args, ctx) {
        const arg = args.trim();
        if (arg.length === 0) {
          ctx.ui.notify(listed(agent));
          return;
        }
        const parts = arg.split(/\s+/);
        const what = parts[0];
        const name = parts.slice(1).join(" ").trim();
        if (what === "reset") {
          const names: string[] = [];
          for (const t of agent.getAllTools()) names.push(t.name);
          agent.setActiveTools(names);
          agent.appendEntry("tools-switch", { active: agent.getActiveTools() });
          ctx.ui.notify("Every tool is on.");
          return;
        }
        if (what !== "off" && what !== "on") {
          ctx.ui.notify("Use /tools, /tools off <name>, /tools on <name>, or /tools reset.");
          return;
        }
        if (name.length === 0) {
          ctx.ui.notify("Use /tools " + what + " <name>.");
          return;
        }
        const known = agent.getAllTools().some((t) => t.name === name);
        if (!known) {
          ctx.ui.notify("No tool named " + name + ".");
          return;
        }
        const next: string[] = [];
        for (const active of agent.getActiveTools()) if (active !== name) next.push(active);
        if (what === "on" && !next.includes(name)) next.push(name);
        agent.setActiveTools(next);
        agent.appendEntry("tools-switch", { active: agent.getActiveTools() });
        ctx.ui.notify(name + " is " + (what === "off" ? "off." : "on."));
      },
    });
  },
});

export {};
