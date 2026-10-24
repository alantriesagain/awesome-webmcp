// What a shell command runs: its segments (one simple command each, split at `&&`, `||`, `;`, `|`
// and newlines outside quotes, substitutions and groups), and the programs they name (`git
// status`, `pnpm install`, `node`), for a call's line and the session's counts. A loop, a
// conditional, a function or a heredoc stays one segment, named by its keyword. No shell grammar
// is parsed beyond that: a command this cannot read names nothing rather than something wrong.

/** The programs whose first argument that is not a flag names what they do. */
const SUBCOMMANDS = new Set(["git", "pnpm", "npm", "npx", "yarn", "gh", "docker", "cargo", "go", "kubectl", "systemctl", "apt", "brew", "pip", "light", "light-native", "widecode", "scriptc"]);
/** Flags before a subcommand that take the next word. */
const VALUED = new Set(["-C", "-c", "--filter", "-F", "--workspace", "-w", "--prefix", "--cwd", "--dir", "-p", "--project", "--context", "-n", "--namespace", "--profile"]);
/** Words a segment starts with that run the command after them. */
const WRAPPERS = new Set(["sudo", "env", "time", "nice", "nohup", "exec", "command", "builtin", "xargs"]);
/** Words that open a compound, which stays one segment named by the word. */
const KEYWORDS = new Set(["if", "for", "while", "until", "case", "function", "select", "{", "("]);
/** The keywords whose compound ends at a closing word. */
const COMPOUNDS = new Set(["if", "for", "while", "until", "case", "select"]);
/** Segments that say nothing about what ran. */
const SILENT = new Set(["cd", "export", "set", "unset", "shift", "true", "false", ":", "echo", "printf", "sleep", "wait", "exit", "return", "read", "pushd", "popd", "local", "declare", "source", "."]);

/** The simple commands of `command`, each as its own text. */
export const segments = (command: string): string[] => {
  const out: string[] = [];
  let current = "";
  let quote = "";
  let depth = 0;
  let heredoc = "";
  // A compound (`for … done`, `if … fi`, `case … esac`, `while … done`) is one segment: its own
  // `;` and `|` are its parts, not the chain's.
  const open = (): boolean => {
    const head = /^\s*(\S+)/.exec(current);
    return head !== null && COMPOUNDS.has(head[1]) && !new RegExp("(^|\\s)" + (head[1] === "if" ? "fi" : head[1] === "case" ? "esac" : "done") + "\\s*;?\\s*$").test(current.trim());
  };
  const push = (): void => {
    const text = current.trim();
    if (text.length > 0) out.push(text);
    current = "";
  };
  const lines = command.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (heredoc.length > 0) {
      current += "\n" + line;
      if (line.trim() === heredoc) heredoc = "";
      continue;
    }
    if (n > 0 && quote.length === 0 && depth === 0 && !open()) push();
    else if (n > 0) current += "\n";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote.length > 0) {
        current += c;
        if (c === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
        else if (c === quote) quote = "";
        continue;
      }
      if (c === "\\" && i + 1 < line.length) {
        current += c + line[++i];
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        quote = c;
        current += c;
        continue;
      }
      if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
      if (c === "(" || c === "{" || c === "[") depth++;
      else if ((c === ")" || c === "}" || c === "]") && depth > 0) depth--;
      if (depth === 0 && c === "<" && line.slice(i, i + 2) === "<<") {
        const m = /^<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line.slice(i));
        if (m !== null) heredoc = m[1];
      }
      if (depth === 0 && !open() && (c === ";" || c === "|" || c === "&")) {
        const two = line.slice(i, i + 2);
        if (two === "&&" || two === "||" || two === ";;") i++;
        else if (c === "&" && line[i + 1] === ">") {
          current += c;
          continue;
        }
        if (c === "|" && two !== "||" && line[i + 1] === "&") i++;
        if (c === ";" || c === "|" || two === "&&" || two === "||" || line[i + 1] === undefined || /\s/.test(line[i + 1])) {
          push();
          continue;
        }
      }
      current += c;
    }
  }
  push();
  return out;
};

/** The words of a segment, quotes dropped; a word of a quoted text is one word. */
const words = (segment: string): string[] => {
  const out: string[] = [];
  let word = "";
  let quote = "";
  let has = false;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote.length > 0) {
      if (c === quote) quote = "";
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < segment.length) word += segment[++i];
    else if (/\s/.test(c)) {
      if (word.length > 0 || has) out.push(word);
      word = "";
      has = false;
    } else word += c;
  }
  if (word.length > 0 || has) out.push(word);
  return out;
};

/** The program a segment runs, with its subcommand when the program has them (`git status`); "" when the segment says nothing. */
export const programOf = (segment: string): string => {
  const all = words(segment);
  let at = 0;
  while (at < all.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(all[at]) || WRAPPERS.has(all[at]) || (at > 0 && all[at].startsWith("-")))) at++;
  if (at >= all.length) return "";
  let name = all[at];
  if (KEYWORDS.has(name)) return name === "{" || name === "(" ? "" : name;
  if (name.startsWith("$(") || name.startsWith("`")) return "";
  name = name.slice(name.lastIndexOf("/") + 1);
  if (SILENT.has(name)) return "";
  if (!SUBCOMMANDS.has(name)) return name;
  for (let i = at + 1; i < all.length; i++) {
    const w = all[i];
    if (w.startsWith("-")) {
      if (VALUED.has(w)) i++;
      continue;
    }
    return name + " " + w;
  }
  return name;
};

/** The body of a compound (`for … ; do BODY; done`, `if …; then BODY; fi`), with its head, as one command of its own; "" for a simple command. */
const inside = (segment: string): string => {
  const head = /^\s*(\S+)/.exec(segment);
  if (head === null || !COMPOUNDS.has(head[1])) return "";
  return segment
    .replace(/^\s*(for|select)\s+\S+\s+in\s/, "")
    .replace(/^\s*(while|until|if)\s/, "")
    .replace(/^\s*case\s+\S+\s+in\s/, "")
    .replace(/(^|[;\s])(do|then|else|elif|fi|done|esac)(?=[;\s]|$)/g, ";")
    .replace(/^\s*;\s*/, "");
};

/** The programs `command` runs, in order, each once; a compound's are the ones its body runs. */
export const programsOf = (command: string): string[] => {
  const out: string[] = [];
  const walk = (text: string, depth: number): void => {
    for (const segment of segments(text)) {
      const body = depth < 4 ? inside(segment) : "";
      if (body.length > 0) walk(body, depth + 1);
      else {
        const program = programOf(segment);
        if (program.length > 0 && !out.includes(program)) out.push(program);
      }
    }
  };
  walk(command, 0);
  return out;
};

/** The programs of `commands` with how many commands ran each, most first. */
export const programCounts = (commands: string[]): { program: string; calls: number }[] => {
  const counts = new Map<string, number>();
  for (const command of commands) for (const program of programsOf(command)) counts.set(program, (counts.get(program) ?? 0) + 1);
  return [...counts.entries()].map(([program, calls]) => ({ program, calls })).sort((a, b) => b.calls - a.calls || (a.program < b.program ? -1 : 1));
};
