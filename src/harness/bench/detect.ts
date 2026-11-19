// The benchmark's wasted work: reading a run's transcript (the format run.ts writes) and
// flagging what an agent did over again. Each detector is one rule with a one-line description
// and a function from a transcript to the calls that broke it; the report sums them per agent
// and shows a few examples. `node src/harness/bench/detect.ts <transcript files or folders>...`
// prints the report for those transcripts.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { num, recordOf, str } from "@lightstart/lib/json.ts";

/** One call a detector flags, and why. */
export class Hit {
  readonly call: number;
  readonly reason: string;

  constructor(call: number, reason: string) {
    this.call = call;
    this.reason = reason;
  }
}

/** The first line of a transcript: what ran and whether it got to the task. */
export class TranscriptHeader {
  task = "";
  agent = "";
  model = "";
  web = false;
  passed = false;
  setupFailed = false;

  static parse(r: Record<string, unknown>): TranscriptHeader {
    const h = new TranscriptHeader();
    h.task = str(r["task"]);
    h.agent = str(r["agent"]);
    h.model = str(r["model"]);
    h.web = r["web"] === true;
    h.passed = r["passed"] === true;
    h.setupFailed = r["setupFailed"] === true;
    return h;
  }
}

/** One tool call: the agent's own name for it and the kind the transcript groups it under. */
export class TranscriptCall {
  n = 0;
  tool = "";
  as = "";
  path = "";
  command = "";
  input = "";
  failed = false;
  resultChars = 0;
  result = "";
  atMs = 0;

  static parse(r: Record<string, unknown>): TranscriptCall {
    const c = new TranscriptCall();
    c.n = num(r["n"], 0);
    c.tool = str(r["tool"]);
    c.as = str(r["as"]);
    c.path = str(r["path"]);
    c.command = str(r["command"]);
    c.input = str(r["input"]);
    c.failed = r["failed"] === true;
    c.resultChars = num(r["resultChars"], 0);
    c.result = str(r["result"]);
    c.atMs = num(r["atMs"], 0);
    return c;
  }
}

/** One piece of assistant text. */
export class TranscriptText {
  atMs = 0;
  text = "";

  static parse(r: Record<string, unknown>): TranscriptText {
    const t = new TranscriptText();
    t.atMs = num(r["atMs"], 0);
    t.text = str(r["text"]);
    return t;
  }
}

/** A run's transcript: its header (when it has one), its calls and its texts. */
export class Transcript {
  readonly path: string;
  header: TranscriptHeader | null = null;
  readonly calls: TranscriptCall[] = [];
  readonly texts: TranscriptText[] = [];

  constructor(path: string) {
    this.path = path;
  }

  file(): string {
    return basename(this.path);
  }
}

const parseLine = (line: string): Record<string, unknown> | null => {
  if (line.trim().length === 0) return null;
  let value: unknown = null;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return recordOf(value);
};

/** A transcript file read: a line that does not parse is skipped, and a header only counts once. */
export const readTranscript = (path: string): Transcript => {
  const t = new Transcript(path);
  let content = "";
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return t;
  }
  for (const line of content.split("\n")) {
    const r = parseLine(line);
    if (r === null) continue;
    const kind = str(r["kind"]);
    if (kind === "run") {
      if (t.header === null) t.header = TranscriptHeader.parse(r);
    } else if (kind === "call") {
      t.calls.push(TranscriptCall.parse(r));
    } else if (kind === "text") {
      t.texts.push(TranscriptText.parse(r));
    }
  }
  return t;
};

const isRead = (c: TranscriptCall): boolean => c.as === "read";
const isEdit = (c: TranscriptCall): boolean => c.as === "edit" || c.as === "write";
const isBash = (c: TranscriptCall): boolean => c.as === "bash";

/** A short, single-line cut of `s`, for a reason. */
const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : one.slice(0, n) + "...";
};

/** The offset and limit a read names, or "" when its input shows neither. */
const offsetSignature = (c: TranscriptCall): string => {
  if (c.input.length === 0) return "";
  let value: unknown = null;
  try {
    value = JSON.parse(c.input);
  } catch {
    return "";
  }
  const r = recordOf(value);
  if (r === null) return "";
  const offset = r["offset"];
  const limit = r["limit"];
  if (offset === undefined && limit === undefined) return "";
  return (offset === undefined ? "-" : String(offset)) + ":" + (limit === undefined ? "-" : String(limit));
};

/** Whether a call's result shows a failure: the call failed, or its text names one. */
const showsFailure = (c: TranscriptCall): boolean => {
  if (c.failed) return true;
  // A count of none ("0 failed", "# fail 0", "failures: 0") is no failure.
  const text = c.result.toLowerCase().replace(/\b0\s+(failed|failing|failures?)\b|\b(fail|failed|failures?)\s*:?\s+0\b/g, "");
  if (/\b[1-9][0-9]*\s+(failed|failing|failures?)\b/.test(text)) return true;
  return /\b(failed|failure|failures|fail)\b/.test(text);
};

/** A bash command that runs tests. */
const isTestCommand = (command: string): boolean => /node .*test|npm test|pnpm test|npx vitest|jest|mocha/.test(command);

/** A detector: its id, its rule in one line, and the calls of a transcript that break it. */
export class Detector {
  readonly id: string;
  readonly description: string;
  readonly hitsOf: (t: Transcript) => Hit[];

  constructor(id: string, description: string, hitsOf: (t: Transcript) => Hit[]) {
    this.id = id;
    this.description = description;
    this.hitsOf = hitsOf;
  }
}

const refusedThenRead = (t: Transcript): Hit[] => {
  const hits: Hit[] = [];
  for (let i = 0; i < t.calls.length; i++) {
    const first = t.calls[i];
    if (!isEdit(first) || !first.failed || first.path.length === 0) continue;
    let read = -1;
    for (let j = i + 1; j < t.calls.length; j++) {
      const c = t.calls[j];
      if (c.path !== first.path) continue;
      if (isRead(c)) {
        read = j;
        break;
      }
      if (isEdit(c)) break;
    }
    if (read < 0) continue;
    for (let k = read + 1; k < t.calls.length; k++) {
      const c = t.calls[k];
      if (c.path !== first.path) continue;
      if (isEdit(c)) {
        hits.push(new Hit(t.calls[read].n, "read after its edit was refused"));
        break;
      }
      if (isRead(c)) break;
    }
  }
  return hits;
};

const reread = (t: Transcript): Hit[] => {
  const hits: Hit[] = [];
  const paths: string[] = [];
  const signatures: string[] = [];
  const live: boolean[] = [];
  for (const c of t.calls) {
    if (c.path.length === 0) continue;
    const at = paths.indexOf(c.path);
    if (at < 0) {
      if (isRead(c)) {
        paths.push(c.path);
        signatures.push(offsetSignature(c));
        live.push(true);
      }
      continue;
    }
    if (isRead(c)) {
      const signature = offsetSignature(c);
      if (live[at] && signatures[at] === signature) hits.push(new Hit(c.n, "read again with no edit between"));
      live[at] = true;
      signatures[at] = signature;
    } else if (isEdit(c) && !c.failed) {
      live[at] = false;
      signatures[at] = "";
    }
  }
  return hits;
};

const readAfterEdit = (t: Transcript): Hit[] => {
  const hits: Hit[] = [];
  const paths: string[] = [];
  const afterWrite: boolean[] = [];
  for (const c of t.calls) {
    if (c.path.length === 0) continue;
    const at = paths.indexOf(c.path);
    if (isEdit(c)) {
      if (at < 0) {
        paths.push(c.path);
        afterWrite.push(!c.failed);
      } else if (!c.failed) {
        afterWrite[at] = true;
      }
      continue;
    }
    if (!isRead(c)) continue;
    if (at < 0) {
      paths.push(c.path);
      afterWrite.push(false);
      continue;
    }
    if (afterWrite[at]) hits.push(new Hit(c.n, "read after its edit"));
    afterWrite[at] = false;
  }
  return hits;
};

// A command that exits otherwise than 0 is a failed call to the harness and none to opencode, so
// bash's failures are counted apart from the tools': only the second compare across agents.
const failedCall = (t: Transcript): Hit[] => {
  const hits: Hit[] = [];
  for (const c of t.calls) {
    if (c.failed && !isBash(c)) hits.push(new Hit(c.n, clip(c.tool + ": " + c.result, 80)));
  }
  return hits;
};

const failedCommand = (t: Transcript): Hit[] => {
  const hits: Hit[] = [];
  for (const c of t.calls) {
    if (c.failed && isBash(c)) hits.push(new Hit(c.n, clip(c.command + ": " + c.result, 80)));
  }
  return hits;
};

const repeatCommand = (t: Transcript): Hit[] => {
  const hits: Hit[] = [];
  const seen: string[] = [];
  for (const c of t.calls) {
    if (isEdit(c) && !c.failed) {
      seen.length = 0;
      continue;
    }
    if (!isBash(c) || c.command.length === 0) continue;
    if (seen.indexOf(c.command) >= 0) hits.push(new Hit(c.n, "same command run again: " + clip(c.command, 60)));
    else seen.push(c.command);
  }
  return hits;
};

const verifyAfterPass = (t: Transcript): Hit[] => {
  const hits: Hit[] = [];
  let passed = false;
  for (const c of t.calls) {
    if (isEdit(c) && !c.failed) {
      passed = false;
      continue;
    }
    if (!isBash(c) || !isTestCommand(c.command)) continue;
    const clean = !showsFailure(c);
    if (clean && passed) hits.push(new Hit(c.n, "tests run again after they passed"));
    passed = clean;
  }
  return hits;
};

const packageManagerOnWeb = (t: Transcript): Hit[] => {
  const hits: Hit[] = [];
  if (t.header === null || !t.header.web) return hits;
  const registry = /\b(?:npm|pnpm|yarn|bun)(?:\s+-\S+)*\s+(?:view|info|show|search)\b|\bnpm(?:\s+-\S+)*\s+v\s|registry\.npmjs\.org|registry\.yarnpkg\.com/i;
  for (const c of t.calls) {
    if (isBash(c) && registry.test(c.command)) hits.push(new Hit(c.n, "package registry asked from bash: " + clip(c.command, 60)));
  }
  return hits;
};

const webThroughBash = (t: Transcript): Hit[] => {
  const hits: Hit[] = [];
  if (t.header === null || !t.header.web) return hits;
  for (const c of t.calls) {
    if (isBash(c) && /\b(?:curl|wget)\b/i.test(c.command)) hits.push(new Hit(c.n, "curl rather than the web tools: " + clip(c.command, 60)));
  }
  return hits;
};

/** Every detector, in the order the report shows them. */
export const detectors: Detector[] = [
  new Detector("refused-then-read", "A failed edit or write, a read of that path, then an edit or write of it.", refusedThenRead),
  new Detector("reread", "A read of a path already read in the run, with no edit or write between.", reread),
  new Detector("read-after-edit", "A read of a path whose last call was an edit or write that succeeded.", readAfterEdit),
  new Detector("failed-call", "A call of a tool other than bash that failed, with its tool and result.", failedCall),
  new Detector("failed-command", "A bash command the agent marked failed (the harness marks a command that exits otherwise than 0; opencode marks none).", failedCommand),
  new Detector("repeat-command", "The same bash command run again with no edit or write between.", repeatCommand),
  new Detector("verify-after-pass", "Tests run again after a run of them showed no failure and no edit or write between.", verifyAfterPass),
  new Detector("package-manager-on-web", "A bash command that asks a package registry on a web task.", packageManagerOnWeb),
  new Detector("web-through-bash", "A bash command that runs curl or wget on a web task.", webThroughBash),
];

/** Every .jsonl file in a folder, and a file path as given. */
const expand = (paths: string[]): string[] => {
  const out: string[] = [];
  for (const path of paths) {
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) {
      out.push(path);
      continue;
    }
    let names: string[] = [];
    try {
      names = readdirSync(path).sort();
    } catch {
      continue;
    }
    for (const name of names) if (name.endsWith(".jsonl")) out.push(join(path, name));
  }
  return out;
};

const cell = (runs: Transcript[], agent: string, detector: Detector): string => {
  let hits = 0;
  let runsHit = 0;
  for (const r of runs) {
    if (r.header === null || r.header.agent !== agent) continue;
    const found = detector.hitsOf(r);
    hits += found.length;
    if (found.length > 0) runsHit++;
  }
  return String(hits) + "/" + String(runsHit);
};

/** The flags of some transcripts as markdown: a detector by agent table, then examples. */
export const flagsReport = (paths: string[]): string => {
  const runs: Transcript[] = [];
  for (const file of expand(paths)) {
    const t = readTranscript(file);
    if (t.header !== null && !t.header.setupFailed) runs.push(t);
  }
  if (runs.length === 0) return "";
  const agents: string[] = [];
  for (const r of runs) {
    if (r.header === null) continue;
    if (agents.indexOf(r.header.agent) < 0) agents.push(r.header.agent);
  }
  if (agents.indexOf("harness") >= 0) {
    agents.splice(agents.indexOf("harness"), 1);
    agents.unshift("harness");
  }
  const lines: string[] = [];
  lines.push("| detector | " + agents.join(" | ") + " |");
  lines.push("|---|" + agents.map(() => "---").join("|") + "|");
  for (const d of detectors) lines.push("| " + d.id + " | " + agents.map((a) => cell(runs, a, d)).join(" | ") + " |");
  for (const d of detectors) {
    const examples: string[] = [];
    for (const r of runs) {
      if (examples.length >= 5) break;
      const header = r.header;
      if (header === null) continue;
      for (const h of d.hitsOf(r)) {
        if (examples.length >= 5) break;
        examples.push("- " + header.task + ", " + header.agent + ", " + r.file() + ", call " + String(h.call) + ": " + h.reason);
      }
    }
    if (examples.length === 0) continue;
    lines.push("");
    lines.push("### " + d.id);
    lines.push(d.description);
    for (const e of examples) lines.push(e);
  }
  return lines.join("\n");
};

const invoked = process.argv[1] ?? "";
if (invoked.length > 0 && import.meta.url === pathToFileURL(invoked).href) {
  console.log(flagsReport(process.argv.slice(2)));
}
