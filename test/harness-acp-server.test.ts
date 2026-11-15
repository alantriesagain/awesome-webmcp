// The ACP server's framing: lines in any pieces, requests and notifications told apart, the
// client's ids echoed as they came (a number, a string), a response to one of ours settling its
// promise, an error answer rejecting it, a line that is not JSON skipped, the trace of the lines.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpServer, Incoming } from "../src/harness/acp/server.ts";
import { done, eq } from "@lightstart/test/assert.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const main = async (): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "harness-acp-"));
  const s = new AcpServer();
  const out: string[] = [];
  const got: string[] = [];
  s.sink = (line: string) => out.push(line);
  s.onIncoming = (m: Incoming) => got.push(m.method + " " + m.idText + " " + JSON.stringify(m.params));
  s.tracePath = join(dir, "trace.log");

  s.feed(bytes('{"jsonrpc":"2.0","id":1,"meth'));
  eq("a line waits for its newline", String(got.length), "0");
  s.feed(bytes('od":"initialize","params":{"protocolVersion":1}}\n{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"x"}}\nnot json\n'));
  eq("a request and a notification, told apart by the id", got.join(" | "), 'initialize 1 {"protocolVersion":1} | session/cancel  {"sessionId":"x"}');
  s.feed(bytes('{"jsonrpc":"2.0","id":"abc","method":"session/list","params":{}}\n'));
  eq("a string id comes as JSON text", got[2], 'session/list "abc" {}');

  s.answer("1", '{"ok":true}');
  s.refuse('"abc"', -32601, "no");
  s.notify("session/update", '{"sessionId":"x"}');
  eq("answers, refusals and notifications as lines", out.join(" | "), '{"jsonrpc":"2.0","id":1,"result":{"ok":true}} | {"jsonrpc":"2.0","id":"abc","error":{"code":-32601,"message":"no"}} | {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"x"}}');

  const asked = s.sendRequest("session/request_permission", '{"q":1}');
  eq("a request of ours, numbered from 1", out[3], '{"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{"q":1}}');
  s.feed(bytes('{"jsonrpc":"2.0","id":1,"result":{"outcome":"selected"}}\n'));
  eq("settled by the client's response", JSON.stringify(await asked), '{"outcome":"selected"}');
  const failed = s.sendRequest("x", "{}");
  s.feed(bytes('{"jsonrpc":"2.0","id":2,"error":{"code":-1,"message":"nope"}}\n'));
  let why = "";
  try {
    await failed;
  } catch (err) {
    why = err instanceof Error ? err.message : "?";
  }
  eq("an error answer rejects it", why, "nope");
  s.feed(bytes('{"jsonrpc":"2.0","id":9,"result":{}}\n'));
  eq("an answer to no request of ours is ignored", String(got.length), "3");

  const trace = readFileSync(join(dir, "trace.log"), "utf8").split("\n").filter((l) => l.length > 0);
  eq("every line in and out is traced, with its direction", String(trace.filter((l) => l.startsWith("in  ")).length) + " in, " + String(trace.filter((l) => l.startsWith("out ")).length) + " out", "7 in, 5 out");
  rmSync(dir, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
