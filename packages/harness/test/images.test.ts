// Images: a Read of an image file gives the model the image when it reads images (else a refusal
// that says so), the result carrying it to Anthropic's API as a block of its content and to a chat
// completions API as a user message after the tool messages; a prompt's image blocks become parts
// of the user's message for such a model, and a note for another.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAgent } from "../acp/agent.ts";
import { AcpServer, Incoming } from "../acp/server.ts";
import { Auth } from "../auth.ts";
import { registryFor } from "../cli.ts";
import { HarnessConfig } from "../config.ts";
import { Abort } from "../loop/abort.ts";
import { messagesJson } from "../model/anthropic.ts";
import { ModelClient } from "../model/client.ts";
import { FakeClient } from "../model/fake.ts";
import { IMAGE, Message, Part, TOOL_RESULT } from "../model/message.ts";
import { chatMessagesJson } from "../model/openai.ts";
import { ModelRegistry } from "../model/registry.ts";
import { HarnessPaths } from "../paths.ts";
import { ToolContext, ToolSet, builtInTools } from "../tools/tool.ts";
import { done, eq, ok } from "@light/test/assert.ts";

/** A 1×1 PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const until = (what: () => boolean): Promise<void> =>
  new Promise<void>((settle) => {
    const tick = (): void => {
      if (what()) settle();
      else setTimeout(tick, 10);
    };
    tick();
  });

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "harness-images-"));
  writeFileSync(join(folder, "dot.png"), Buffer.from(PNG, "base64"));
  const tools = new ToolSet(builtInTools());
  const ctx = new ToolContext(folder, "build", new Set<string>());
  const blind = await tools.run("Read", '{"file_path":"dot.png"}', ctx, new Abort(), null);
  eq("a model that reads no images: refused, said so", blind.text + " " + String(blind.isError), "dot.png is an image, and this model does not read images true");
  ctx.vision = true;
  const seen = await tools.run("Read", '{"file_path":"dot.png"}', ctx, new Abort(), null);
  eq("one that does: the image attached", seen.text + " | " + seen.imageType + " | " + String(seen.imageData === PNG), "The image dot.png (image/png, 1 KB), attached. | image/png | true");

  const r = new Part(TOOL_RESULT);
  r.callId = "call_1";
  r.text = seen.text;
  r.mediaType = seen.imageType;
  r.data = seen.imageData;
  const results = new Message("user", "u2");
  results.parts.push(r);
  ok("to Anthropic: the result's content, its text and the image", messagesJson([results], false) === '[{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":[{"type":"text","text":"The image dot.png (image/png, 1 KB), attached."},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"' + PNG + '"}}]}]}]');
  ok("to a chat completions API: the tool message, then the image as the user's", chatMessagesJson([], [results], "") === '[{"role":"tool","tool_call_id":"call_1","content":"The image dot.png (image/png, 1 KB), attached."},{"role":"user","content":[{"type":"text","text":"The image from call call_1:"},{"type":"image_url","image_url":{"url":"data:image/png;base64,' + PNG + '"}}]}]');
  eq("Anthropic's models read images, DeepSeek's do not", ModelRegistry.builtIn().models.filter((m) => m.vision).map((m) => m.provider).filter((p, i, all) => all.indexOf(p) === i).join(","), "anthropic,opencode");

  // A prompt's image: a part of the user's message for a model that reads images, a note for another.
  const config = new HarnessConfig();
  const registry = registryFor(config, true);
  const fake = registry.model("fake/fake");
  if (fake !== null) fake.vision = true;
  const server = new AcpServer();
  const out: string[] = [];
  server.sink = (line: string) => out.push(line);
  const fixture = FakeClient.fromText("");
  const agent = new AcpAgent(server, new ModelClient(registry, new Auth(join(folder, "auth.json")), "node", fixture), new ToolSet(builtInTools()), registry, config, "test", "linux", new HarnessPaths(join(folder, "home")));
  agent.receive(new Incoming("session/new", { cwd: folder, mcpServers: [] }, "1"));
  const sid = /"sessionId":"([^"]+)"/.exec(out[0])?.[1] ?? "";
  agent.receive(new Incoming("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "what is this" }, { type: "image", mimeType: "image/png", data: PNG }] }, "2"));
  await until(() => out.some((l) => l.includes('"id":2,')));
  const first = agent.messagesOf(sid)[0];
  eq("the user's message: its text, then the image", first.parts.map((p) => p.kind + (p.kind === IMAGE ? ":" + p.mediaType + ":" + String(p.data === PNG) : ":" + p.text)).join(" "), "text:what is this image:image/png:true");
  if (fake !== null) fake.vision = false;
  agent.receive(new Incoming("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "and this" }, { type: "image", mimeType: "image/png", data: PNG }] }, "3"));
  await until(() => out.some((l) => l.includes('"id":3,')));
  const later = agent.messagesOf(sid).filter((m) => m.role === "user");
  eq("for one that does not: a note in its place", later[later.length - 1].parts.map((p) => p.kind + ":" + p.text).join(" "), "text:and this\n\n[1 image was attached; this model does not read images, so they were left out]");
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
