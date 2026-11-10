// A tool the model can call: its name as Claude Code names it (so the UI's summaries, the fixed
// prompt's wording and any future rules apply), what it does, its input's JSON schema as text,
// the ACP kind its calls show as, and whether it changes the world (a batch with one runs its
// calls one at a time). The set of a mode runs a call by name, after checking its input against
// the schema; one flat class and a switch, since an overridden method cannot be async natively.
import { listOf, listText, objectText, parseJson, recordOf, str, strs } from "@light/lib/json.ts";
import { Abort } from "../loop/abort.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { McpLink } from "./mcp.ts";
import { readTool } from "./read.ts";
import { skillTool } from "./skill.ts";
import { WebSettings, webFetchTool, webSearchTool } from "./web.ts";
import { writeTool } from "./write.ts";

export class ToolContext {
  readonly cwd: string;
  readonly mode: string;
  /** The files read in the session (absolute paths): what Edit and Write may change. */
  readonly reads: Set<string>;
  /** The session's MCP servers, whose tools are named `mcp__<server>__<tool>`. */
  servers: McpLink[] = [];
  /** What the Skill tool reads: the folder's skills when trusted, the user's home ("" for none), the harness's folder. */
  trusted = false;
  home = "";
  harnessRoot = "";
  /** What WebFetch and WebSearch have: the browser, the search backends. */
  web = new WebSettings();
  /** Whether the session's model reads images. */
  vision = false;
  /** What an extension tool's ctx reports: the session's model, system prompt and context. */
  modelValue = "";
  systemPrompt = "";
  tokens = 0;
  window = 0;

  constructor(cwd: string, mode: string, reads: Set<string>) {
    this.cwd = cwd;
    this.mode = mode;
    this.reads = reads;
  }
}

/** What a call produced: its text for the model, whether it failed, the files it touched, the raw output for the UI as JSON text, and a change: the file, whether it was created, its texts before and after, the patch with its line numbers. */
export class ToolOutcome {
  text = "";
  isError = false;
  locations: string[] = [];
  rawOutputJson = "";
  diffPath = "";
  created = false;
  oldText = "";
  newText = "";
  patch = "";
  /** An image the call gives the model (a Read of an image file): its type and base64 data. */
  imageType = "";
  imageData = "";
  /** An extension tool's `details`, as JSON text ("" for none), kept in the session file's outcome. */
  detailsJson = "";

  static failed(why: string): ToolOutcome {
    const o = new ToolOutcome();
    o.text = why;
    o.isError = true;
    return o;
  }

  /** The outcome as JSON text, kept beside a call's result in a session file; `kind` the tool's ACP kind, `title` what its call showed as. */
  json(kind: string, title: string): string {
    const text = this.text.length > 2048 ? this.text.slice(0, 2048) + "…" : this.text;
    return objectText(["kind", "title", "text", "isError", "locations", "diffPath", "created", "oldText", "newText", "patch", "rawOutputJson", "detailsJson"], [JSON.stringify(kind), JSON.stringify(title), JSON.stringify(text), this.isError ? "true" : "false", listText(this.locations.map((l) => JSON.stringify(l))), JSON.stringify(this.diffPath), this.created ? "true" : "false", JSON.stringify(this.oldText), JSON.stringify(this.newText), JSON.stringify(this.patch), JSON.stringify(this.rawOutputJson), JSON.stringify(this.detailsJson)]);
  }

  /** An outcome and its kind from that text; null when it is not one. */
  static parse(text: string): KeptOutcome | null {
    const r = recordOf(parseJson(text));
    if (r === null) return null;
    const o = new ToolOutcome();
    o.text = str(r["text"]);
    o.isError = r["isError"] === true;
    o.locations = strs(r["locations"]);
    o.diffPath = str(r["diffPath"]);
    o.created = r["created"] === true;
    o.oldText = str(r["oldText"]);
    o.newText = str(r["newText"]);
    o.patch = str(r["patch"]);
    o.rawOutputJson = str(r["rawOutputJson"]);
    o.detailsJson = str(r["detailsJson"]);
    return new KeptOutcome(o, str(r["kind"]), str(r["title"]));
  }
}

/** An outcome read back from a session file, with the ACP kind and the title of its call ("" when not kept). */
export class KeptOutcome {
  readonly outcome: ToolOutcome;
  readonly kind: string;
  readonly title: string;

  constructor(outcome: ToolOutcome, kind: string, title: string) {
    this.outcome = outcome;
    this.kind = kind;
    this.title = title;
  }
}

/** What runs a tool an extension registered, a callback field rather than a method: a subclass's async method does not compile natively. */
export class ExtraTool {
  runExtra: ((inputJson: string, ctx: ToolContext, abort: Abort) => Promise<ToolOutcome>) | null = null;
}

export class Tool {
  readonly name: string;
  readonly description: string;
  readonly schemaJson: string;
  /** The ACP kind of its calls: read, edit, execute, search, fetch, other. */
  readonly kind: string;
  readonly mutating: boolean;
  /** What its calls show as to the client: the name, but for an MCP tool (`widecode_AskUser`). */
  title: string;
  /** What runs it when an extension registered it (null for a built-in or MCP tool). */
  extra: ExtraTool | null = null;

  constructor(name: string, description: string, schemaJson: string, kind: string, mutating: boolean) {
    this.name = name;
    this.description = description;
    this.schemaJson = schemaJson;
    this.kind = kind;
    this.mutating = mutating;
    this.title = name;
  }

  /** The tool as a chat completions API's list takes it. */
  openAiJson(): string {
    return '{"type":"function","function":{"name":' + JSON.stringify(this.name) + ',"description":' + JSON.stringify(this.description) + ',"parameters":' + this.schemaJson + "}}";
  }

  /** The tool as the API's list takes it, with Anthropic's extras when `extras` (eager input streaming, a cache breakpoint when `cached`). */
  json(extras: boolean, cached: boolean): string {
    return '{"name":' + JSON.stringify(this.name) + ',"description":' + JSON.stringify(this.description) + ',"input_schema":' + this.schemaJson + (extras ? ',"eager_input_streaming":true' : "") + (extras && cached ? ',"cache_control":{"type":"ephemeral"}' : "") + "}";
  }
}

const WRITE_SCHEMA = '{"type":"object","properties":{"file_path":{"type":"string","description":"The file to write, absolute or relative to the folder"},"content":{"type":"string","description":"The whole content"}},"required":["file_path","content"]}';
const EDIT_SCHEMA = '{"type":"object","properties":{"file_path":{"type":"string","description":"The file to change"},"old_string":{"type":"string","description":"The exact text to replace (it must occur once, unless replace_all)"},"new_string":{"type":"string","description":"What replaces it"},"replace_all":{"type":"boolean","description":"Replace every occurrence"}},"required":["file_path","old_string","new_string"]}';
const GREP_SCHEMA = '{"type":"object","properties":{"pattern":{"type":"string","description":"A regular expression"},"path":{"type":"string","description":"The folder or file to search, relative to the folder (the folder by default)"},"include":{"type":"string","description":"A glob the file names must match, such as *.ts"},"ignoreCase":{"type":"boolean"},"context":{"type":"integer","description":"Lines of context around each match"}},"required":["pattern"]}';
const GLOB_SCHEMA = '{"type":"object","properties":{"pattern":{"type":"string","description":"A glob over relative paths, such as src/**/*.ts (a bare name matches at any depth)"},"path":{"type":"string","description":"The folder to search (the folder by default)"}},"required":["pattern"]}';
const SKILL_SCHEMA = '{"type":"object","properties":{"name":{"type":"string","description":"The name of the skill, as the system prompt lists it"}},"required":["name"]}';
const FETCH_SCHEMA = '{"type":"object","properties":{"url":{"type":"string","description":"The page, an http or https address"},"prompt":{"type":"string","description":"What you want from the page, in a few words"}},"required":["url"]}';
const SEARCH_SCHEMA = '{"type":"object","properties":{"query":{"type":"string","description":"What to search for"},"limit":{"type":"integer","description":"How many results (8 by default, 20 at most)"}},"required":["query"]}';
const TASK_SCHEMA = '{"type":"object","properties":{"description":{"type":"string","description":"The task in three to five words"},"prompt":{"type":"string","description":"The whole task for the subagent, with what it needs to know: it sees nothing of this conversation"},"subagent_type":{"type":"string","description":"general-purpose"}},"required":["description","prompt"]}';
const LS_SCHEMA = '{"type":"object","properties":{"path":{"type":"string","description":"The folder to list (the folder by default)"}},"required":[]}';
const READ_SCHEMA = '{"type":"object","properties":{"file_path":{"type":"string","description":"The file to read, absolute or relative to the folder"},"offset":{"type":"integer","description":"The line to start from, 1-based"},"limit":{"type":"integer","description":"How many lines to read (2000 by default)"}},"required":["file_path"]}';
const BASH_SCHEMA = '{"type":"object","properties":{"command":{"type":"string","description":"The command, run by bash in the folder"},"timeout":{"type":"integer","description":"A timeout in milliseconds (120000 by default, 600000 at most)"},"description":{"type":"string","description":"What the command does, in a few words"}},"required":["command"]}';

/** The built-in tools. */
export const builtInTools = (): Tool[] => [
  new Tool("Read", "Read a file: its lines numbered, 2000 at a time, 2000 characters per line at most. Read a file before you edit it.", READ_SCHEMA, "read", false),
  new Tool("Write", "Write a whole file (its folders made). For a file that exists, read it first; prefer Edit for a change to part of it.", WRITE_SCHEMA, "edit", true),
  new Tool("Edit", "Replace an exact string in a file you have read with another. old_string must occur exactly once (give enough context), unless replace_all.", EDIT_SCHEMA, "edit", true),
  new Tool("Bash", "Run a shell command in the folder with bash and get its output (30 KB kept, the start and the end). No interactive commands; prefer Read, Grep and Glob for reading and searching files.", BASH_SCHEMA, "execute", true),
  new Tool("Grep", "Search the folder's files for a regular expression: file, line number and line, 200 matches at most.", GREP_SCHEMA, "search", false),
  new Tool("Glob", "Find files by a glob over their relative paths, newest first, 500 at most.", GLOB_SCHEMA, "search", false),
  new Tool("LS", "List a folder's entries (folders end with a slash).", LS_SCHEMA, "read", false),
  new Tool("Skill", "Load a skill's instructions by name (the system prompt lists the skills): follow them for the task.", SKILL_SCHEMA, "read", false),
  new Tool("WebFetch", "Fetch a web page through a headless browser (its scripts run) and get its main content as markdown, 50,000 characters at most. http and https addresses only.", FETCH_SCHEMA, "fetch", false),
  new Tool("Task", "Give a self-contained task to a subagent: a fresh session on the same model with the same tools (but Task), which works on it and replies with a report, the only part of its work this conversation sees. Use it for a search or a change whose steps the conversation does not need; several in one reply run together.", TASK_SCHEMA, "other", false),
  new Tool("WebSearch", "Search the web: numbered results with their titles, addresses and snippets. Read a result with WebFetch.", SEARCH_SCHEMA, "fetch", false),
];

const READ_ONLY = ["Read", "Grep", "Glob", "LS", "Skill", "WebFetch", "WebSearch"];

export class ToolSet {
  readonly tools: Tool[];

  constructor(tools: Tool[]) {
    this.tools = tools;
  }

  /** The tools of `mode`: every one in build, the read-only ones in plan. */
  forMode(mode: string): ToolSet {
    return mode === "plan" ? new ToolSet(this.tools.filter((t) => READ_ONLY.includes(t.name))) : this;
  }

  /** These tools but `name` (a subagent's: no Task of its own). */
  without(name: string): ToolSet {
    return new ToolSet(this.tools.filter((t) => t.name !== name));
  }

  /** These tools and `more` (a session's MCP or extension tools), one of `more` replacing a tool of its name. */
  plus(more: Tool[]): ToolSet {
    if (more.length === 0) return this;
    const kept = this.tools.filter((t) => !more.some((m) => m.name === t.name));
    return new ToolSet(kept.concat(more));
  }

  find(name: string): Tool | null {
    for (const t of this.tools) if (t.name === name) return t;
    return null;
  }

  /** The API's tools list ("" with none), the last tool cached when `extras`. */
  json(extras: boolean): string {
    if (this.tools.length === 0) return "";
    return "[" + this.tools.map((t, i) => t.json(extras, i === this.tools.length - 1)).join(",") + "]";
  }

  /** The chat completions API's tools list ("" with none). */
  openAiJson(): string {
    if (this.tools.length === 0) return "";
    return "[" + this.tools.map((t) => t.openAiJson()).join(",") + "]";
  }

  /** Why `inputJson` is not an input for `name` ("" when it is): not JSON, not an object, a required field missing, a field of the wrong type. */
  checkInput(name: string, inputJson: string): string {
    const t = this.find(name);
    if (t === null) return "no tool named " + name;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(inputJson.length > 0 ? inputJson : "{}");
    } catch {
      return "the input is not valid JSON";
    }
    const input = recordOf(parsed);
    if (input === null) return "the input is not an object";
    const schema = recordOf(parseJson(t.schemaJson));
    const props = schema !== null ? recordOf(schema["properties"]) : null;
    for (const field of strs(schema !== null ? schema["required"] : [])) if (input[field] === undefined || input[field] === null) return "the input lacks " + field;
    if (props !== null)
      for (const field of Object.keys(props)) {
        const value = input[field];
        if (value === undefined || value === null) continue;
        const wanted = str(recordOf(props[field])?.["type"]);
        const got = typeof value;
        if ((wanted === "string" && got !== "string") || ((wanted === "integer" || wanted === "number") && got !== "number") || (wanted === "boolean" && got !== "boolean") || (wanted === "array" && !Array.isArray(value))) return field + " should be a " + wanted;
      }
    return "";
  }

  /** Run `name` with its input (JSON text, validated already) in `ctx`; `onOutput` hears a long call's output as it comes. */
  async run(name: string, inputJson: string, ctx: ToolContext, abort: Abort, onOutput: ((text: string) => void) | null): Promise<ToolOutcome> {
    const input = recordOf(parseJson(inputJson.length > 0 ? inputJson : "{}")) ?? {};
    const found = this.find(name);
    const extra = found !== null ? found.extra : null;
    if (extra !== null && extra.runExtra !== null) return extra.runExtra(inputJson, ctx, abort);
    switch (name) {
      case "Read": {
        const o = await readTool(input, ctx);
        for (const p of o.locations) if (!o.isError) ctx.reads.add(p);
        return o;
      }
      case "Write":
        return writeTool(input, ctx);
      case "Edit":
        return editTool(input, ctx);
      case "Bash":
        return bashTool(input, ctx, abort, onOutput);
      case "Grep":
        return grepTool(input, ctx);
      case "Glob":
        return globTool(input, ctx);
      case "LS":
        return lsTool(input, ctx);
      case "Skill":
        return skillTool(input, ctx);
      case "WebFetch":
        return webFetchTool(input, ctx, abort);
      case "WebSearch":
        return webSearchTool(input, ctx, abort);
      default: {
        // An MCP server's tool: `mcp__<server>__<tool>`.
        const m = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/.exec(name);
        const server = m !== null ? m[1] : "";
        const tool = m !== null ? m[2] : "";
        const link = ctx.servers.find((l) => l.name.replace(/[^A-Za-z0-9_-]/g, "_") === server) ?? null;
        if (m === null || link === null) return ToolOutcome.failed("no tool named " + name);
        const got = await link.callTool(tool, inputJson, abort);
        const o = new ToolOutcome();
        o.text = got.text;
        o.isError = got.isError;
        return o;
      }
    }
  }
}

export { listOf };
