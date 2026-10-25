// A tool the model can call: its name as Claude Code names it (so the UI's summaries, the fixed
// prompt's wording and any future rules apply), what it does, its input's JSON schema as text,
// the ACP kind its calls show as, and whether it changes the world (a batch with one runs its
// calls one at a time). The set of a mode runs a call by name, after checking its input against
// the schema; one flat class and a switch, since an overridden method cannot be async natively.
import { listOf, parseJson, recordOf, str, strs } from "@light/lib/json.ts";
import { Abort } from "../loop/abort.ts";
import { bashTool } from "./bash.ts";
import { readTool } from "./read.ts";

export class ToolContext {
  readonly cwd: string;
  readonly mode: string;

  constructor(cwd: string, mode: string) {
    this.cwd = cwd;
    this.mode = mode;
  }
}

/** What a call produced: its text for the model, whether it failed, the files it touched, the raw output for the UI as JSON text, and a change's diff (later). */
export class ToolOutcome {
  text = "";
  isError = false;
  locations: string[] = [];
  rawOutputJson = "";
  diffPath = "";
  oldText = "";
  newText = "";
  patch = "";

  static failed(why: string): ToolOutcome {
    const o = new ToolOutcome();
    o.text = why;
    o.isError = true;
    return o;
  }
}

export class Tool {
  readonly name: string;
  readonly description: string;
  readonly schemaJson: string;
  /** The ACP kind of its calls: read, edit, execute, search, fetch, other. */
  readonly kind: string;
  readonly mutating: boolean;

  constructor(name: string, description: string, schemaJson: string, kind: string, mutating: boolean) {
    this.name = name;
    this.description = description;
    this.schemaJson = schemaJson;
    this.kind = kind;
    this.mutating = mutating;
  }

  /** The tool as the API's list takes it, with Anthropic's extras when `extras` (eager input streaming, a cache breakpoint when `cached`). */
  json(extras: boolean, cached: boolean): string {
    return '{"name":' + JSON.stringify(this.name) + ',"description":' + JSON.stringify(this.description) + ',"input_schema":' + this.schemaJson + (extras ? ',"eager_input_streaming":true' : "") + (extras && cached ? ',"cache_control":{"type":"ephemeral"}' : "") + "}";
  }
}

const READ_SCHEMA = '{"type":"object","properties":{"file_path":{"type":"string","description":"The file to read, absolute or relative to the folder"},"offset":{"type":"integer","description":"The line to start from, 1-based"},"limit":{"type":"integer","description":"How many lines to read (2000 by default)"}},"required":["file_path"]}';
const BASH_SCHEMA = '{"type":"object","properties":{"command":{"type":"string","description":"The command, run by bash in the folder"},"timeout":{"type":"integer","description":"A timeout in milliseconds (120000 by default, 600000 at most)"},"description":{"type":"string","description":"What the command does, in a few words"}},"required":["command"]}';

/** The built-in tools. */
export const builtInTools = (): Tool[] => [
  new Tool("Read", "Read a file: its lines numbered, 2000 at a time, 2000 characters per line at most. Read a file before you edit it.", READ_SCHEMA, "read", false),
  new Tool("Bash", "Run a shell command in the folder with bash and get its output (30 KB kept, the start and the end). No interactive commands; prefer dedicated tools for reading files.", BASH_SCHEMA, "execute", true),
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

  find(name: string): Tool | null {
    for (const t of this.tools) if (t.name === name) return t;
    return null;
  }

  /** The API's tools list ("" with none), the last tool cached when `extras`. */
  json(extras: boolean): string {
    if (this.tools.length === 0) return "";
    return "[" + this.tools.map((t, i) => t.json(extras, i === this.tools.length - 1)).join(",") + "]";
  }

  /** Why `inputJson` is not an input for `name` ("" when it is): not JSON, not an object, a required field missing, a field of the wrong type. */
  validate(name: string, inputJson: string): string {
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
    switch (name) {
      case "Read":
        return readTool(input, ctx);
      case "Bash":
        return bashTool(input, ctx, abort, onOutput);
      default:
        return ToolOutcome.failed("no tool named " + name);
    }
  }
}

export { listOf };
