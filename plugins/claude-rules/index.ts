// Claude rules: the Markdown files of the session folder's `.claude/rules/` are appended to the
// turn's system prompt, each under a heading with its file name, so a project's rules reach the
// model without a tool call. A folder without that directory leaves the system prompt alone.

const MARKER = "@@widecode-rule ";
const SCRIPT = 'for f in .claude/rules/*.md; do [ -f "$f" ] || continue; printf "@@widecode-rule %s\\n" "$f"; cat "$f"; printf "\\n"; done';

/** The file name in `path`: what follows its last "/". */
const baseName = (path: string): string => {
  const at = path.lastIndexOf("/");
  return at >= 0 ? path.slice(at + 1) : path;
};

/** The rules in the script's output, each under a heading with its file name ("" for none). */
const rulesIn = (text: string): string => {
  const sections: string[] = [];
  let name = "";
  let body: string[] = [];
  const finish = (): void => {
    if (name.length === 0) return;
    sections.push("## " + name + "\n\n" + body.join("\n").trim());
  };
  for (const line of text.split("\n")) {
    if (line.startsWith(MARKER)) {
      finish();
      name = baseName(line.slice(MARKER.length).trim());
      body = [];
      continue;
    }
    if (name.length > 0) body.push(line);
  }
  finish();
  return sections.join("\n\n");
};

widecode.plugin({
  id: "claude-rules",
  agent(agent) {
    agent.on("before_agent_start", async (event) => {
      const result = await agent.exec("sh", ["-c", SCRIPT], { timeout: 10000 });
      const rules = rulesIn(result.stdout);
      if (rules.length === 0) return;
      return { systemPrompt: event.systemPrompt + "\n\n# Project rules\n\n" + rules };
    });
  },
});

export {};
