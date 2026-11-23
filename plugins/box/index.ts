// Host actions: commands only the host can run (installing widecode's build into ~/.local/bin,
// a deploy with production credentials), which an agent asks for and the user approves each time
// unless the action is read-only and marked so. The commands come from config.json's "box"
// section, never from an agent's input:
//   { "hostActions": { "install": { "run": "node_modules/.bin/light install",
//     "description": "build widecode and install it into ~/.local/bin", "timeoutMs": 900000 } } }
// `run` is a shell command run in the session's folder; `description` says what it does;
// `timeoutMs` is how long it may take (10 minutes by default). An action may take one argument,
// named by a glob pattern:
//   { "arg": "social/queue/*.json" }
// The tool then takes an `arg` that must match the whole pattern, hold no shell metacharacters and
// no "..", and resolve inside the session's folder; it is shell-quoted, replacing a literal {arg}
// in `run` or appended to it. An action without "arg" refuses one. `approve` is "always" (the
// default) or "never" for a read-only action, which runs without asking and is noted in the log.
// With "show": true, the file the argument names is copied into a host temp folder a boxed agent
// cannot reach, the copy is shown whole in the approval question (a file over 4000 characters is
// refused) and the command runs on the copy, so what runs is what was approved. Only the user's or a trusted project's config.json
// defines them. The HostAction tool is offered while at least one is configured; /box lists them.

/** A configured host action. */
interface HostAction {
  name: string;
  run: string;
  description: string;
  timeoutMs: number;
  arg: string | null;
  approve: "always" | "never";
  show: boolean;
}

const DEFAULT_TIMEOUT_MS = 600000;
const MAX_SHOWN = 4000;
/** What a shell would read as more than a plain word; an argument holding one is refused. */
const METACHARS = /[;&|$`\\'"<>(){}[\]*?!#~\n\r]/;
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
    const pattern = entry !== null ? str(entry.arg) : "";
    actions.push({
      name: name,
      run: run,
      description: entry !== null ? str(entry.description) : "",
      timeoutMs: timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
      arg: pattern.length > 0 ? pattern : null,
      approve: entry !== null && str(entry.approve) === "never" ? "never" : "always",
      show: entry !== null && entry.show === true,
    });
  }
  return actions;
};

/** Whether `value` matches the whole glob `pattern` (`*` any run, `?` one character); everything else is literal. */
const matchesGlob = (pattern: string, value: string): boolean => {
  let source = "^";
  for (const ch of pattern) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(source + "$").test(value);
};

/** A path with `.` and `..` applied, absolute. */
const normalize = (path: string): string => {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
    } else out.push(part);
  }
  return "/" + out.join("/");
};

/** The path `arg` names under `folder`, or "" when it resolves outside it. */
const underFolder = (folder: string, arg: string): string => {
  const base = normalize(folder);
  const path = normalize(arg.startsWith("/") ? arg : base + "/" + arg);
  return path === base || path.startsWith(base + "/") ? path : "";
};

/**
 * A copy of the file `path` in a fresh host temp folder, which a boxed agent cannot reach (the jail's
 * /tmp is its own), so the file the user approves is the file the command runs on even when the
 * original changes after the question. Answers the copy's path and its text; refuses a file the
 * question could not show whole.
 */
const snapshot = async (api: widecode.Api, path: string): Promise<{ path: string; text: string }> => {
  const made = await api.process.run("dir=$(mktemp -d) && cp -- " + quote(path) + ' "$dir/" && printf %s "$dir"', "", 10000);
  const dir = made.out.trim();
  if (made.code !== 0 || dir.length === 0) throw new Error("could not copy " + path + " for the approval: " + made.err.trim());
  const copy = dir + "/" + path.slice(path.lastIndexOf("/") + 1);
  const text = api.fs.text(copy);
  if (text === null) throw new Error("could not read the copy of " + path);
  if (text.length > MAX_SHOWN) throw new Error(path + " has " + String(text.length) + " characters, more than the " + String(MAX_SHOWN) + " an approval shows whole");
  return { path: copy, text };
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

    const described = actions
      .map((a) => a.name + (a.arg !== null ? " (arg matches " + a.arg + ")" : "") + (a.description.length > 0 ? ": " + a.description : ""))
      .join("; ");
    api.tools.add({
      name: "HostAction",
      category: "run",
      description:
        "Run one of this project's host actions, commands only the host can run, which the user approves each time unless the action is read-only and marked so. Actions: " +
        described +
        ".",
      input: {
        type: "object",
        properties: {
          action: { type: "string", enum: names, description: "Which action to run." },
          arg: { type: "string", description: "The argument an action declares one for; refused for the others." },
          reason: { type: "string", description: "Why it is needed, shown to the user with the command." },
        },
        required: ["action", "reason"],
      },
      call: async (args, ctx) => {
        const name = str(args.action);
        const action = actions.find((a) => a.name === name);
        if (action === undefined) throw new Error("no host action " + name + "; it has " + names.join(", "));
        const reason = str(args.reason);
        const raw = str(args.arg);
        const folder = api.state.active().folder;
        let path = "";
        if (action.arg === null) {
          if (raw.length > 0 || (args.arg !== undefined && args.arg !== null)) throw new Error(action.name + " takes no arg");
        } else {
          if (raw.length === 0) throw new Error(action.name + " needs an arg matching " + action.arg);
          if (!matchesGlob(action.arg, raw)) throw new Error("the arg " + raw + " does not match " + action.arg + " for " + action.name);
          if (raw.includes("..")) throw new Error("a host action's arg may not contain ..");
          if (METACHARS.test(raw)) throw new Error("a host action's arg may not contain shell metacharacters");
          path = underFolder(folder, raw);
          if (path.length === 0) throw new Error("the arg names a file outside the session's folder: " + raw);
        }
        const copy = action.arg !== null && action.show ? await snapshot(api, path) : null;
        let command = action.run;
        if (action.arg !== null) {
          const word = quote(copy !== null ? copy.path : raw);
          command = action.run.includes("{arg}") ? action.run.split("{arg}").join(word) : action.run + " " + word;
        }
        let question = "Run on the host: " + action.name + " (" + command + ")?" + (reason.length > 0 ? "\n\n" + reason : "");
        if (action.arg !== null) {
          question += "\n\narg: " + raw;
          if (copy !== null) question += "\n\n" + raw + " (the command runs on this copy):\n" + copy.text;
        }
        api.note("host action asked: " + action.name + (reason.length > 0 ? ": " + reason : ""));
        if (action.approve === "never") {
          api.note("host action " + action.name + ": ran without approval");
        } else {
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
        }
        const result = await api.process.run("cd " + quote(folder) + " && " + command, "", action.timeoutMs);
        api.note("host action " + action.name + ": exit code " + String(result.code) + (result.timedOut ? " (timed out)" : ""));
        const output = outputOf(result.out, result.err);
        const head = "exit code " + String(result.code) + (result.timedOut ? " (timed out)" : "");
        return output.length > 0 ? head + "\n" + output : head;
      },
    });
  },
});

export {};
