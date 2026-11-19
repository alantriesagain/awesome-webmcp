// WebFetch in the loop: a long page with a prompt is read by one extra model request whose
// answer is the tool's result, its usage the session's cost; a short page and a call without a
// prompt take the page as it is; a failed request falls back to the page cut at its limit; the
// config's `harness.fetchModel` chooses the extra request's model.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../src/harness/auth.ts";
import { registryFor } from "../src/harness/cli.ts";
import { HarnessConfig } from "../src/harness/config.ts";
import { Abort } from "../src/harness/loop/abort.ts";
import { LoopListener } from "../src/harness/loop/listener.ts";
import { AgentLoop, LoopSession } from "../src/harness/loop/loop.ts";
import { ModelClient } from "../src/harness/model/client.ts";
import { FakeClient } from "../src/harness/model/fake.ts";
import { ToolOutcome, ToolSet, builtInTools } from "../src/harness/tools/tool.ts";
import { WebSettings } from "../src/harness/tools/web.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const SECRET = "The secret number is 424242.";

const LONG = '<html><head><title>Long page</title></head><body><h1>Long</h1><p>' + "filler ".repeat(3000) + "</p><p>" + SECRET + "</p></body></html>";
const SHORT = '<html><head><title>Short page</title></head><body><p>Short and sweet.</p></body></html>';

const fixture = (input: unknown, second: unknown): FakeClient =>
  FakeClient.fromText([JSON.stringify({ match: "fetch", text: "Looking.", tools: [{ name: "WebFetch", input }] }), JSON.stringify(second), JSON.stringify({ match: "result", text: "Finished." })].join("\n"));

const run = async (client: FakeClient, web: WebSettings, folder: string, model: string, config = new HarnessConfig()): Promise<{ outs: ToolOutcome[]; subs: number[] }> => {
  const registry = registryFor(config, true);
  const loop = new AgentLoop(new ModelClient(registry, new Auth(join(folder, "auth.json")), "node", client), new ToolSet(builtInTools()));
  loop.fetchModel = config.fetchModel;
  const s = new LoopSession();
  s.model = model;
  s.cwd = folder;
  s.system = ["Be brief."];
  s.web = web;
  const l = new LoopListener();
  const outs: ToolOutcome[] = [];
  const subs: number[] = [];
  l.onToolEnd = (_id: string, o: ToolOutcome) => outs.push(o);
  l.onSubUsage = (u) => subs.push(u.input);
  await loop.run(s, "fetch it", l, new Abort());
  return { outs, subs };
};

const main = async (): Promise<void> => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url === "/long") res.end(LONG);
    else if (url === "/short") res.end(SHORT);
    else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  const port = await new Promise<number>((settle) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      settle(a !== null && typeof a === "object" ? a.port : 0);
    });
  });
  const base = "http://127.0.0.1:" + String(port);
  const folder = mkdtempSync(join(tmpdir(), "harness-fetch-"));
  const web = new WebSettings();
  web.profileRoot = join(folder, "profiles");

  const longUrl = base + "/long";
  const asked = "What is the secret number?";
  const longClient = fixture({ url: longUrl, prompt: asked }, { match: "URL:", text: SECRET, input: 111, output: 9 });
  const long = await run(longClient, web, folder, "fake/fake");
  eq("a long page with a prompt makes one extra request", String(longClient.requests.length), "3");
  const extra = longClient.requests[1].messages[longClient.requests[1].messages.length - 1].text();
  ok("the extra request holds the address, the prompt and the page", extra.includes(longUrl) && extra.includes(asked) && extra.includes(SECRET) && extra.includes("<page>"));
  eq("the tool's result is the model's answer", long.outs[0].text, "Answer from " + longUrl + " for: " + asked + "\n\n" + SECRET);
  eq("the extra request's usage reaches onSubUsage", long.subs.join(","), "111");
  eq("the extra request uses the session's model", longClient.requests[1].model, "fake/fake");
  ok("the extra request carries no tools", longClient.requests[1].toolsJson === "" && longClient.requests[1].toolsOpenAiJson === "");

  const shortClient = fixture({ url: base + "/short", prompt: asked }, { match: "URL:", text: "never asked" });
  const short = await run(shortClient, web, folder, "fake/fake");
  eq("a short page makes no extra request", String(shortClient.requests.length), "2");
  ok("a short page comes as it did", short.outs[0].text.includes("Fetched for: " + asked) && short.outs[0].text.includes("Short and sweet."));
  eq("a short page costs nothing more", short.subs.join(","), "");

  const noPromptClient = fixture({ url: longUrl }, { match: "URL:", text: "never asked" });
  const noPrompt = await run(noPromptClient, web, folder, "fake/fake");
  eq("a call without a prompt makes no extra request", String(noPromptClient.requests.length), "2");
  ok("a call without a prompt keeps the page", !noPrompt.outs[0].text.includes("Fetched for:") && noPrompt.outs[0].text.includes(SECRET));

  const failedClient = fixture({ url: longUrl, prompt: asked }, { match: "URL:", error: "the model broke" });
  const failed = await run(failedClient, web, folder, "fake/fake");
  eq("a failed extra request is still one request", String(failedClient.requests.length), "3");
  ok("a failed extra request falls back to the page", failed.outs[0].text.startsWith("The answer could not be made: the model broke.") && failed.outs[0].text.includes(SECRET) && failed.outs[0].text.includes("Fetched for: " + asked));
  eq("a failed extra request is not an error result", String(failed.outs[0].isError), "false");

  const configPath = join(folder, "config.json");
  writeFileSync(configPath, JSON.stringify({ harness: { fetchModel: "fake/reader" } }));
  const config = HarnessConfig.read(configPath);
  eq("the config's fetch model read", config.fetchModel, "fake/reader");
  const readerClient = fixture({ url: longUrl, prompt: asked }, { match: "URL:", text: SECRET, input: 50, output: 4 });
  const reader = await run(readerClient, web, folder, "fake/fake", config);
  eq("harness.fetchModel chooses the extra request's model", readerClient.requests[1].model, "fake/reader");
  eq("the session's model answers the turn", readerClient.requests[0].model, "fake/fake");
  eq("the reader's usage reaches onSubUsage", reader.subs.join(","), "50");

  server.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
