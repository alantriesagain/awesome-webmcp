// Inline bash: a prompt's `!{command}` runs the command with sh and the prompt takes its output,
// so the model reads the result without a tool call. Its stdout loses the last newline; a command
// that fails contributes `[exit <code>: <stderr>]`. A prompt without `!{` is left alone.

const PATTERN = /!\{([^}]*)\}/g;

/** `text` without one newline at its end. */
const withoutLastNewline = (text: string): string => (text.endsWith("\n") ? text.slice(0, -1) : text);

lightcode.plugin({
  id: "inline-bash",
  agent(agent) {
    agent.on("input", async (event) => {
      if (!event.text.includes("!{")) return;
      const pattern = new RegExp(PATTERN.source, "g");
      let out = "";
      let last = 0;
      let match = pattern.exec(event.text);
      while (match !== null) {
        out += event.text.slice(last, match.index);
        const command = match[1];
        const result = await agent.exec("sh", ["-c", command], { timeout: 10000 });
        out += result.code === 0 ? withoutLastNewline(result.stdout) : "[exit " + String(result.code) + ": " + result.stderr.trim() + "]";
        last = match.index + match[0].length;
        match = pattern.exec(event.text);
      }
      out += event.text.slice(last);
      return { action: "transform", text: out };
    });
  },
});

export {};
