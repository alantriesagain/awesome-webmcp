// A confirm before a dangerous shell command. On a Bash tool call whose command holds one of its
// patterns the plugin asks the user to run it, and blocks the call when the answer is no or there is
// no UI to ask. config.json's "permission-gate" section may replace the patterns:
//   { "plugins": { "permission-gate": { "patterns": ["rm -rf", "git push --force"] } } }

const DEFAULT_PATTERNS = [
  "rm -rf",
  "rm -fr",
  "sudo ",
  "chmod -R 777",
  "chown -R",
  "mkfs",
  "dd if=",
  "> /dev/sd",
  "git push --force",
  "git push -f",
  "git reset --hard",
  "git clean -fd",
];

/** `value` as the list of strings it holds, else `fallback`. */
const stringsOf = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) return fallback;
  const out: string[] = [];
  for (const v of value as unknown[]) out.push(String(v));
  return out;
};

widecode.plugin({
  id: "permission-gate",
  defaults: () => ({ patterns: DEFAULT_PATTERNS.slice() }),
  agent(agent) {
    const patterns = stringsOf(agent.settings()["patterns"], DEFAULT_PATTERNS);
    agent.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "Bash") return;
      const command = typeof event.input["command"] === "string" ? String(event.input["command"]) : "";
      let matched = "";
      for (const pattern of patterns) {
        if (command.includes(pattern)) {
          matched = pattern;
          break;
        }
      }
      if (matched === "") return;
      if (!ctx.hasUI) return { block: true, reason: "permission-gate: no UI to confirm a command matching " + JSON.stringify(matched) };
      const yes = await ctx.ui.confirm("Run this command?", command);
      if (!yes) return { block: true, reason: "permission-gate: refused a command matching " + JSON.stringify(matched) };
    });
  },
});

export {};
