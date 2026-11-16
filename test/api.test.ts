// node-only: the test walks the repository (src/api/*.ts, src/runtime/runtime.ts, widecode.d.ts, PLUGINS.md) to compare the API's three sides.
// The plugin API's three sides agree: every call the prelude makes (its built text, `call` and
// `later`) has an answer in the runtime (a `case` in src/runtime/runtime.ts or src/api/*.ts), every
// answer has a call, and every call's member is typed in widecode.d.ts (in its namespace's block of
// the Api, or as a method of what it returns, a handle's).
import { EXT_PRELUDE } from "../src/harness/ext/prelude.ts";
import { PRELUDE } from "../src/runtime/prelude.ts";
import { API_ANSWERS } from "../src/runtime/namespaces.ts";
import { NAMESPACE_AGENTS } from "../src/api/agent.ts";
import { NAMESPACE_UI } from "../src/api/ui.ts";
import { AGENT_SLOTS, PANEL_SLOTS } from "../src/runtime/slots.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const root = ".";
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** The names matched by group 1 of `re` in `text`, each once, sorted. */
const namesIn = (text: string, re: RegExp): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
  return out.sort();
};

/** The block `{ … }` opening at `at` (the index of its `{`), braces counted. */
const blockAt = (text: string, at: number): string => {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(at, i + 1);
    }
  }
  return text.slice(at);
};

const prelude = PRELUDE;
const inOrder = (text: string, re: RegExp, allowed: string[]): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(re)) if (allowed.includes(m[1]) && !out.includes(m[1])) out.push(m[1]);
  return out;
};
const calls = namesIn(prelude, /\b(?:call|later)\("([a-zA-Z]+(?:\.[a-zA-Z]+)?)"/g);
let answering = read("src/runtime/runtime.ts") + read("src/runtime/router.ts");
if (existsSync(join(root, "src/api"))) for (const f of readdirSync(join(root, "src/api")).sort()) if (f.endsWith(".ts")) answering += read("src/api/" + f);
const cases = namesIn(answering, /case "([a-zA-Z]+(?:\.[a-zA-Z]+)?)":/g);

ok("the prelude makes calls, the runtime answers some", calls.length > 50 && cases.length > 50);
eq("every call has an answer", calls.filter((n: string) => !cases.includes(n)).join(", "), "");
eq("every answer has a call", cases.filter((n: string) => !calls.includes(n)).join(", "), "");

const routed: string[] = [];
for (const group of API_ANSWERS) for (const name of group.names) routed.push(name);
const prefixes: string[] = [];
for (const name of cases) {
  const dot = name.indexOf(".");
  if (dot > 0 && !prefixes.includes(name.slice(0, dot))) prefixes.push(name.slice(0, dot));
}
eq("every namespace with an answer is routed", prefixes.filter((p: string) => !routed.includes(p)).join(", "), "");

// The Api's namespaces in widecode.d.ts, and its members typed anywhere (a handle's methods).
const dts = read("widecode.d.ts");
const apiAt = dts.indexOf("interface Api {");
ok("the Api is typed", apiAt >= 0);
const api = blockAt(dts, dts.indexOf("{", apiAt));
const untyped: string[] = [];
for (const name of calls) {
  const dot = name.indexOf(".");
  if (dot < 0) continue;
  const ns = name.slice(0, dot);
  const member = name.slice(dot + 1);
  const nsAt = api.search(new RegExp("\\n    " + ns + ": \\{"));
  const block = nsAt >= 0 ? blockAt(api, api.indexOf("{", nsAt)) : "";
  const method = new RegExp("\\b" + member + "\\??\\(");
  if (!method.test(block) && !method.test(dts)) untyped.push(name);
}
eq("every call's member is typed", untyped.join(", "), "");

// The hooks: the host's list, what `host.hook()` answers, widecode.d.ts's Hook union and PLUGINS.md's `on(hook, run)` row name the same ones.
const hostSource = read("src/host/host.ts");
const hooksList = /export const HOOKS = \[([^\]]*)\];/.exec(hostSource);
const hooks = hooksList !== null ? namesIn(hooksList[1], /"([a-zA-Z]+)"/g) : [];
const hookAt = hostSource.indexOf("  hook(name: string): Hook | null {");
const switched = hookAt >= 0 ? namesIn(blockAt(hostSource, hostSource.indexOf("{", hookAt)), /case "([a-zA-Z]+)":/g) : [];
const hookUnion = /type Hook = ([^;]*);/.exec(dts);
const typedHooks = hookUnion !== null ? namesIn(hookUnion[1], /"([a-zA-Z]+)"/g) : [];
const docRow = /\| `on\(hook, run\)` \|([^\n]*)/.exec(read("PLUGINS.md"));
const documented = docRow !== null ? namesIn(docRow[1], /`([a-zA-Z]+)`/g).filter((n: string) => hooks.includes(n) || /Changed$|Loaded$|Opened$|Shown$|Sending$/.test(n)) : [];
ok("the host names its hooks", hooks.length > 5);
eq("host.hook answers each of them", switched.join(","), hooks.join(","));
eq("widecode.d.ts types them", typedHooks.join(","), hooks.join(","));
eq("PLUGINS.md documents them", documented.join(","), hooks.join(","));

eq(
  "the agent functions reach the core in the table's order",
  inOrder(NAMESPACE_AGENTS.source, /\ba\.(\w+)/g, AGENT_SLOTS).join(","),
  AGENT_SLOTS.join(","),
);
eq(
  "the panel functions reach the core in the table's order",
  inOrder(NAMESPACE_UI.source, /\bp\.(\w+)/g, PANEL_SLOTS).join(","),
  PANEL_SLOTS.join(","),
);

// The agent API's three sides agree: the harness prelude's agentFor and ctxOf, and widecode.d.ts's
// AgentApi, AgentContext and AgentUi.
const interfaceNames = (name: string): string[] => {
  const at = dts.indexOf("interface " + name + " {");
  return at >= 0 ? namesIn(blockAt(dts, dts.indexOf("{", at)), /^ {4}([a-zA-Z]\w*)\??[(:]/gm) : [];
};
const agentAt = EXT_PRELUDE.indexOf("const agentFor =");
ok("the harness prelude defines agentFor and ctxOf", agentAt >= 0 && EXT_PRELUDE.indexOf("const ctxOf =") >= 0);
const agentFor = blockAt(EXT_PRELUDE, EXT_PRELUDE.indexOf("{", EXT_PRELUDE.indexOf("=> (", agentAt)));
const apiNames = namesIn(agentFor, /^ {4}([a-zA-Z]\w*)\s*:/gm);
const ctxAt = EXT_PRELUDE.indexOf("const ctxOf =");
const ctxAtReturn = EXT_PRELUDE.indexOf("return {", ctxAt);
const ctxObject = blockAt(EXT_PRELUDE, EXT_PRELUDE.indexOf("{", ctxAtReturn));
const ctxNames = namesIn(ctxObject, /^ {4}([a-zA-Z]\w*)\s*[:,]/gm);
const uiObject = blockAt(ctxObject, ctxObject.indexOf("{", ctxObject.indexOf("ui: {")));
const uiNames = namesIn(uiObject, /^ {6}([a-zA-Z]\w*)\s*:/gm);
ok("agentFor, ctxOf and its ui have members", apiNames.length > 5 && ctxNames.length > 5 && uiNames.length > 5);
eq("AgentApi types agentFor's members", interfaceNames("AgentApi").join(","), apiNames.join(","));
eq("AgentContext types ctxOf's members", interfaceNames("AgentContext").join(","), ctxNames.join(","));
eq("AgentUi types ctxOf's ui members", interfaceNames("AgentUi").join(","), uiNames.join(","));

done();
