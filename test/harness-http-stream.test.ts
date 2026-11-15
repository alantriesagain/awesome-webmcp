// The streaming HTTP client against the fake Messages API server, by both ways (node's request
// and the curl binary): the status, the body's text as it streams, the request's headers and body
// as the server saw them, an error status with its body, an abort mid-stream, a connection
// refused. Then the Anthropic client end to end over it: a reply's text and usage, a 500 tried
// again, a bad key refused with the API's message.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../src/harness/auth.ts";
import { HttpRequest, HttpStream, UrlParts } from "../src/harness/http/stream.ts";
import { Abort } from "../src/harness/loop/abort.ts";
import { ModelClient, ModelRequest, StreamListener } from "../src/harness/model/client.ts";
import { Message, textPart } from "../src/harness/model/message.ts";
import { ModelRegistry } from "../src/harness/model/registry.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const SSE = (text: string): string =>
  [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","usage":{"input_tokens":7,"output_tokens":1}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":' + JSON.stringify(text) + "}}",
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ].join("\n\n");

/** The fake server, started on a free port. */
const startServer = (fixture: string, log: string): Promise<{ child: ChildProcess; port: number }> =>
  new Promise((settle, reject) => {
    const child = spawn("node", [join(process.cwd(), "test", "harness", "fake-model.mjs"), "--fixture", fixture, "--log", log], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout!.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      const m = /PORT (\d+)/.exec(out);
      if (m !== null) settle({ child, port: Number(m[1]) });
    });
    child.on("error", (e: Error) => reject(e));
  });

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "harness-http-"));
  const fixture = join(folder, "fixture.jsonl");
  const log = join(folder, "requests.log");
  const records: string[] = [];
  for (const kind of ["node", "curl"]) {
    records.push(JSON.stringify({ status: 200, sse: SSE("hello from " + kind), delayMs: 5 }));
    records.push(JSON.stringify({ status: 500, body: '{"error":{"type":"api_error","message":"boom"}}' }));
    records.push(JSON.stringify({ status: 200, sse: SSE("held"), hold: true }));
  }
  records.push(JSON.stringify({ status: 200, sse: SSE("over http") }));
  records.push(JSON.stringify({ status: 529, body: '{"error":{"type":"overloaded_error","message":"Overloaded"}}' }));
  records.push(JSON.stringify({ status: 200, sse: SSE("after a retry") }));
  records.push(JSON.stringify({ status: 401, body: '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}' }));
  writeFileSync(fixture, records.join("\n") + "\n");
  const server = await startServer(fixture, log);
  const base = "http://127.0.0.1:" + String(server.port);

  const u = UrlParts.parse("https://api.anthropic.com/v1/messages");
  eq("a url's parts", u !== null ? String(u.secure) + " " + u.host + " " + String(u.port) + " " + u.path : "none", "true api.anthropic.com 443 /v1/messages");
  eq("a url with a port and no path", JSON.stringify(UrlParts.parse("http://127.0.0.1:8080")), '{"secure":false,"host":"127.0.0.1","port":8080,"path":"/"}');
  eq("not http", String(UrlParts.parse("ftp://x")), "null");

  for (const kind of ["node", "curl"]) {
    const chunks: string[] = [];
    let status = 0;
    const s = new HttpStream(kind);
    s.onStatus = (n: number) => {
      status = n;
    };
    s.onChunk = (text: string) => chunks.push(text);
    const r = new HttpRequest(base + "/v1/messages");
    r.headers = [["content-type", "application/json"], ["x-api-key", "k-" + kind]];
    r.body = '{"model":"m","stream":true}';
    const end = await s.start(r);
    ok(kind + ": the status, the body streamed in pieces, no error", status === 200 && end.status === 200 && end.error === "" && chunks.length > 1 && chunks.join("").includes('"text":"hello from ' + kind + '"'));
    const seen = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { headers: Record<string, string>; body: string });
    const last = seen[seen.length - 1];
    eq(kind + ": the request's headers and body as the server saw them", last.headers["x-api-key"] + " " + last.headers["content-type"] + " " + last.body, "k-" + kind + " application/json " + r.body);
    const errText: string[] = [];
    const bad = new HttpStream(kind);
    bad.onChunk = (text: string) => errText.push(text);
    const end2 = await bad.start(r);
    eq(kind + ": an error status with its body, no error of the transport", String(end2.status) + " " + end2.error + " " + errText.join(""), '500  {"error":{"type":"api_error","message":"boom"}}');
    const held = new HttpStream(kind);
    const got: string[] = [];
    held.onChunk = (text: string) => {
      got.push(text);
      if (got.join("").includes("message_stop")) held.abort();
    };
    const end3 = await held.start(r);
    eq(kind + ": an abort ends a held stream", end3.error, "aborted");
    const refused = new HttpStream(kind);
    const end4 = await refused.start(new HttpRequest("http://127.0.0.1:1/v1/messages"));
    ok(kind + ": a connection refused is an error", end4.status === 0 && end4.error.length > 0);
  }

  // The Anthropic client over the fake server.
  const registry = ModelRegistry.builtIn();
  const anthropic = registry.provider("anthropic");
  if (anthropic !== null) {
    anthropic.baseUrl = base;
    anthropic.keyEnv = "HARNESS_HTTP_TEST_KEY";
  }
  process.env["HARNESS_HTTP_TEST_KEY"] = "sk-test";
  const client = new ModelClient(registry, new Auth(join(folder, "auth.json")), "node", null);
  const ask = async (text: string): Promise<string> => {
    const m = new Message("user", "u1");
    m.parts.push(textPart(text));
    const req = new ModelRequest("anthropic/claude-haiku-4-5", ["Sys."], [m]);
    const heard: string[] = [];
    const l = new StreamListener();
    l.onText = (d: string) => heard.push(d);
    const end = await client.stream(req, l, new Abort());
    return end.stopReason + " " + heard.join("") + " " + String(end.usage.input) + "/" + String(end.usage.output) + (end.error.length > 0 ? " " + end.error : "");
  };
  eq("a reply's text and usage", await ask("hi"), "end_turn over http 7/3");
  const sent = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { headers: Record<string, string>; body: string });
  const mine = sent[sent.length - 1];
  ok("the request as the API wants it", mine.headers["x-api-key"] === "sk-test" && mine.headers["anthropic-version"] === "2023-06-01" && mine.body.startsWith('{"model":"claude-haiku-4-5","max_tokens":64000,"stream":true,"system":[{"type":"text","text":"Sys.","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]}]'));
  eq("a 529 is tried again", await ask("again"), "end_turn after a retry 7/3");
  eq("a bad key is refused with the API's message", await ask("who"), "error  0/0 authentication_error: invalid x-api-key");
  server.child.stdin!.end();
  server.child.kill("SIGTERM");
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
