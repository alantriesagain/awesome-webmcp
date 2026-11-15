// The plugin API's `tools` calls, answered for the runtime (runtime.ts dispatches by namespace):
// widecode's own tools, which plugins add and agents call over widecode's MCP server
// (src/agent/mcp.ts), and where that server listens, for an agent's plugin to offer it.
import { PreludePart } from "@lightstart/plugins/prelude.ts";
import type { JsRuntime } from "../runtime/runtime.ts";
import { isRecord } from "@lightstart/lib/json.ts";
import { McpTool } from "../agent/mcp.ts";
import { HostAnswer } from "@lightstart/plugins/engine.ts";
import { str, num, strs, json, answer, objectText, refuse } from "./values.ts";

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Plugin call `name` with its arguments `a`, answered; null for a call of another namespace. */
export const answerTools = (rt: JsRuntime, name: string, a: unknown[]): HostAnswer | null => {
  const mcp = rt.mcp;
  switch (name) {
    case "tools.add": {
      // Tool `name` of plugin `owner`, a call of `category`: its calls go to the plugin's function, which answers with toolDone.
      const tool = str(a[1]);
      if (!NAME.test(tool)) return refuse("a tool's name is 1 to 64 letters, digits, _ . or -: " + tool);
      for (const t of mcp.tools) if (t.name === tool) return refuse("a tool " + tool + " is already offered (by " + t.owner + ")");
      const schema = isRecord(a[3]) ? JSON.stringify(a[3]) : '{"type":"object","properties":{}}';
      mcp.tools.push(new McpTool(tool, str(a[2]), schema, str(a[4]), str(a[0]), num(a[5]), strs(a[6])));
      rt.toolsDirty = true;
      return answer(null);
    }
    case "tools.onCancel": {
      // A tool call registered what ends its work when the agent cancels it.
      rt.setToolCancel(str(a[0]), num(a[1]), num(a[2]));
      return answer(null);
    }
    case "tools.server": {
      // Where the server listens, the header that lets plugin `owner`'s agent in, the tools it sees with their kind of call, and a config file naming the server, once it listens; null with no tools for it, or when it cannot listen.
      const owner = str(a[0]);
      const fn = num(a[1]);
      rt.settle(
        owner,
        fn,
        mcp.start().then((url: string) => {
          const tools: string[] = [];
          for (const t of mcp.visible(owner)) tools.push(objectText(["name", "category"], [json(t.name), json(t.category)]));
          if (url.length === 0 || tools.length === 0) return "null";
          return objectText(["url", "headers", "tools", "file"], [json(url), '[{"name":"Authorization","value":' + json("Bearer " + mcp.tokenFor(owner)) + "}]", "[" + tools.join(",") + "]", json(mcp.configFile(owner))]);
        }),
      );
      return answer(null);
    }
  }
  return null;
};

/** The `tools` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_TOOLS = new PreludePart("tools", `        add: (t) =>
          call("tools.add", id, String(t.name), String(t.description ?? ""), t.input ?? null, String(t.category ?? ""), fn((callId, args, toolUseId) => {
            // Its answer, now or once its promise settles: text (a value that is not is JSON), or an error thrown.
            const done = (text, error) => call("toolDone", callId, String(text), error);
            const failed = (e) => done(e instanceof Error ? e.message : String(e), true);
            const ctx = { callId: String(callId), toolUseId: String(toolUseId ?? ""), onCancel: (f) => call("tools.onCancel", id, callId, fn(f)) };
            try {
              Promise.resolve(t.call(args, ctx)).then((r) => done(typeof r === "string" ? r : JSON.stringify(r ?? null), false), failed);
            } catch (e) {
              failed(e);
            }
          }), Array.from(t.except ?? [], String)),
        server: () => later("tools.server", id),
`);
