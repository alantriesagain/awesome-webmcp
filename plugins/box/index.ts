// Host actions: commands only the host can run (installing widecode's build into ~/.local/bin,
// a deploy with production credentials), which an agent asks for and the user approves each time.
// The commands come from config.json's "box" section, never from an agent's input:
//   { "hostActions": { "install": { "run": "node_modules/.bin/light install",
//     "description": "build widecode and install it into ~/.local/bin", "timeoutMs": 900000 } } }
// `run` is a shell command run in the session's folder; `description` says what it does;
// `timeoutMs` is how long it may take (10 minutes by default). Only the user's or a trusted
// project's config.json defines them. The HostAction tool is offered while at least one is
// configured; /box lists them.

/** A configured host action. */
interface HostAction {
  name: string;
  run: string;
  description: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 600000;
const { num, obj, quote, str } = widecode.util;

/** The actions in config.json's "box.hostActions": keys are names, each an entry with a "run". */
const actionsOf = (section: unknown): HostAction[] => {
  const hostActions = obj(obj(section)?.hostActions);
  const actions: HostAction[] = [];
  if (hostActions === null) return actions;
  for (const name of Object.keys(hostActions)) {
    const entry = obj(hostActions[name]);
    const run = entry !== null ? str(entry.run) : "";
    if (run.length === 0) continue;
    const timeout = entry !== null ? num(entry.timeoutMs, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    actions.push({
      name: name,
      run: run,
      description: entry !== null ? str(entry.description) : "",
      timeoutMs: timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    });
  }
  return actions;
};

/** The command's output as its last 60 lines, stdout first and then stderr. */
const outputOf = (out: string, err: string): string => {
  const text = [out, err].filter((part) => part.length > 0).join("\n").replace(/\s+$/, "");
  if (text.length === 0) return "";
  return text.split("\n").slice(-60).join("\n");
};

widecode.plugin({
  id: "box",
  activate(api) {
    const actions = actionsOf(api.settings.section());
    const names = actions.map((a) => a.name);

    api.commands.add({
      name: "/box",
      help: "the host actions this project configures",
      run: () => api.tell(names.length > 0 ? "host actions: " + names.join(", ") : "no host actions configured"),
    });

    if (actions.length === 0) return;

    const described = actions.map((a) => a.name + (a.description.length > 0 ? ": " + a.description : "")).join("; ");
    api.tools.add({
      name: "HostAction",
      category: "run",
      description:
        "Run one of this project's host actions, commands only the host can run, which the user approves each time. Actions: " +
        described +
        ".",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: names, description: "Which action to run." },
          reason: { type: "string", description: "Why it is needed, shown to the user with the command." },
        },
        required: ["action", "reason"],
      },
      call: async (args, ctx) => {
        const name = str(args.action);
        const action = actions.find((a) => a.name === name);
        if (action === undefined) throw new Error("no host action " + name + "; it has " + names.join(", "));
        const reason = str(args.reason);
        const question = "Run on the host: " + action.name + " (" + action.run + ")?" + (reason.length > 0 ? "\n\n" + reason : "");
        api.note("host action asked: " + action.name + (reason.length > 0 ? ": " + reason : ""));
        const reply = await api.conversation.ask(
          {
            category: "question",
            name: "HostAction",
            questions: [
              {
                question: question,
                header: "Host action",
                options: [
                  { label: "Run it", description: "run the command on the host now" },
                  { label: "Don't run", description: "leave it to the user" },
                ],
              },
            ],
          },
          ctx.toolUseId.length > 0 ? ctx.toolUseId : ctx.callId,
        );
        const approved = reply.state === "answered" && reply.answers.length > 0 && reply.answers[0].labels.includes("Run it");
        if (!approved) {
          api.note("host action " + action.name + ": not approved");
          throw new Error("the user did not approve " + action.name);
        }
        const folder = api.state.active().folder;
        const result = await api.process.run("cd " + quote(folder) + " && " + action.run, "", action.timeoutMs);
        api.note("host action " + action.name + ": exit code " + String(result.code) + (result.timedOut ? " (timed out)" : ""));
        const output = outputOf(result.out, result.err);
        const head = "exit code " + String(result.code) + (result.timedOut ? " (timed out)" : "");
        return output.length > 0 ? head + "\n" + output : head;
      },
    });
  },
});

export {};
