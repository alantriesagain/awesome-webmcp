// Keep writes out of the paths a project should not have written by an agent: the environment files,
// the git metadata and the installed packages. On a Write or Edit of such a path the call is
// blocked; on Bash it is blocked when a redirect into one or an `rm` of one is plain in the command.
// config.json's "protected-paths" section may replace the rules, gitignore-style simple globs (`*`
// and `**`, a trailing `/` for a folder):
//   { "plugins": { "protected-paths": { "paths": [".env", "secrets/", "**/*.pem"] } } }

const DEFAULT_PATHS = [".env", ".env.*", ".git/", "node_modules/"];

/** `value` as the list of strings it holds, else `fallback`. */
const stringsOf = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) return fallback;
  const out: string[] = [];
  for (const v of value as unknown[]) out.push(String(v));
  return out;
};

/** `path` resolved against `cwd`, with `.` and `..` applied, as an absolute path. */
const absolute = (path: string, cwd: string): string => {
  const full = path.startsWith("/") ? path : cwd.replace(/\/+$/, "") + "/" + path;
  const parts: string[] = [];
  for (const segment of full.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return "/" + parts.join("/");
};

/** `path` as the folder sees it: relative when it is inside, absolute otherwise. */
const relative = (path: string, cwd: string): string => {
  const abs = absolute(path, cwd);
  const base = absolute(cwd, cwd);
  if (abs === base) return "";
  if (abs.startsWith(base + "/")) return abs.slice(base.length + 1);
  return abs;
};

/** `glob` (with `*` and `**`) as a regular expression body. */
const globSource = (glob: string): string => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]*";
    } else if ("\\^$+.()|{}[]".includes(c)) out += "\\" + c;
    else out += c;
  }
  return out;
};

/** Whether `candidate` matches `pattern`: a trailing slash is a folder, no slash matches a segment anywhere. */
const matches = (candidate: string, pattern: string): boolean => {
  const folder = pattern.endsWith("/");
  const body = folder ? pattern.slice(0, -1) : pattern;
  if (body === "") return false;
  const source = globSource(body);
  if (folder) return new RegExp("(^|/)" + source + "(/|$)").test(candidate);
  if (body.includes("/")) return new RegExp("^" + source + "$").test(candidate);
  const re = new RegExp("^" + source + "$");
  for (const segment of candidate.split("/")) if (re.test(segment)) return true;
  return false;
};

/** The rule `path` breaks ("" for none). */
const ruleFor = (path: string, cwd: string, patterns: string[]): string => {
  const candidate = relative(path, cwd);
  for (const pattern of patterns) if (matches(candidate, pattern)) return pattern;
  return "";
};

/** The paths a command redirects into or removes, as plain as the command makes them. */
const pathsIn = (command: string): string[] => {
  const out: string[] = [];
  const redirect = /(?:^|[^>])>>?\s*("[^"]*"|'[^']*'|[^\s;|&]+)/g;
  for (let m = redirect.exec(command); m !== null; m = redirect.exec(command)) out.push(m[1].replace(/^["']|["']$/g, ""));
  const remove = /\brm\b([^;&|]*)/g;
  for (let m = remove.exec(command); m !== null; m = remove.exec(command)) {
    for (const word of m[1].trim().split(/\s+/)) {
      if (word === "" || word.startsWith("-")) continue;
      out.push(word.replace(/^["']|["']$/g, ""));
    }
  }
  return out;
};

widecode.plugin({
  id: "protected-paths",
  defaults: () => ({ paths: DEFAULT_PATHS.slice() }),
  agent(agent) {
    const patterns = stringsOf(agent.settings()["paths"], DEFAULT_PATHS);
    agent.on("tool_call", (event, ctx) => {
      if (event.toolName === "Write" || event.toolName === "Edit") {
        const path = event.input["file_path"];
        if (typeof path !== "string") return;
        const rule = ruleFor(String(path), ctx.cwd, patterns);
        if (rule === "") return;
        return { block: true, reason: "protected-paths: " + JSON.stringify(rule) + " is protected" };
      }
      if (event.toolName !== "Bash") return;
      const command = typeof event.input["command"] === "string" ? String(event.input["command"]) : "";
      for (const path of pathsIn(command)) {
        const rule = ruleFor(path, ctx.cwd, patterns);
        if (rule === "") continue;
        return { block: true, reason: "protected-paths: " + JSON.stringify(rule) + " is protected" };
      }
    });
  },
});

export {};
