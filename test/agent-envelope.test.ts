import { readFileSync } from "node:fs";
import {
  AssistantEvent,
  BlockStartEvent,
  InitEvent,
  LineSplitter,
  MalformedEvent,
  ResultEvent,
  SystemEvent,
  TextDeltaEvent,
  UnknownEvent,
  decodeEnvelope,
} from "../src/agent/index.ts";
import { done, eq, eqn, ok } from "@lightstart/test/assert.ts";

// 1. The captured session (Claude Code 2.1.282) decodes into the expected sequence.
const fixture = readFileSync("test/agent/fixtures/stream.ndjson", "utf8");
const lines = fixture.split("\n").filter((l) => l.length > 0);
const events = lines.map((l) => decodeEnvelope(l));
eq("fixture kinds", events.map((e) => e.kind).join(","), "init,system,unknown,block_start,delta,assistant,block_stop,unknown,unknown,unknown,result");

const init = events[0];
ok("init is InitEvent", init instanceof InitEvent);
if (init instanceof InitEvent) {
  eq("init session", init.sessionId, "ed00b5a3-65da-4307-8e7c-9df2c0ae350b");
  eq("init model", init.model, "claude-fable-5-1");
  eq("init version", init.version, "2.1.282");
  eqn("init tools (mcp only, builtins disabled)", init.tools.length, 8);
}
const status = events[1];
ok("status is SystemEvent", status instanceof SystemEvent && status.subtype === "status" && status.status === "requesting");
const modeOnly = decodeEnvelope('{"type":"system","subtype":"status","status":null,"permissionMode":"plan"}');
ok("a status line with a null status (a mode change) decodes", modeOnly instanceof SystemEvent && modeOnly.status === "");
const start = events[3];
ok("block_start text", start instanceof BlockStartEvent && start.index === 0 && start.blockType === "text");
const delta = events[4];
ok("delta PONG", delta instanceof TextDeltaEvent && delta.index === 0 && delta.text === "PONG");
const asst = events[5];
ok("assistant text", asst instanceof AssistantEvent && asst.text === "PONG" && asst.blockTypes.join() === "text" && asst.messageId.startsWith("msg_"));
const rate = events[9];
ok("rate_limit_event is unknown", rate instanceof UnknownEvent && rate.type === "rate_limit_event");
const res = events[10];
ok("result is ResultEvent", res instanceof ResultEvent);
if (res instanceof ResultEvent) {
  eq("result subtype", res.subtype, "success");
  ok("result not error", !res.isError);
  eqn("result turns", res.numTurns, 1);
  ok("result cost > 0", res.costUsd > 0);
  eq("result text", res.result, "PONG");
  eqn("result duration", res.durationMs, 1275);
  eqn("result errors", res.errors.length, 0);
}

// 2. Width tolerance: extra keys at every nesting level are ignored; unknown types never throw.
const extra = decodeEnvelope('{"type":"stream_event","zzz":{"deep":[1,{"a":2}]},"event":{"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"hi","more":true},"x":1}}');
ok("extra keys delta", extra instanceof TextDeltaEvent && extra.index === 3 && extra.text === "hi");
const toolUse = decodeEnvelope('{"type":"assistant","message":{"id":"msg_1","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"p":"/x"}},{"type":"text","text":"after","citations":[]}]}}');
ok("assistant with tool_use block", toolUse instanceof AssistantEvent && toolUse.text === "after" && toolUse.blockTypes.join(",") === "tool_use,text");
const unknownType = decodeEnvelope('{"type":"something_new","subtype":"x","payload":{"n":1}}');
ok("unknown type", unknownType instanceof UnknownEvent && unknownType.type === "something_new" && unknownType.subtype === "x");
const noType = decodeEnvelope('{"foo":1}');
ok("missing type", noType instanceof UnknownEvent && noType.type === "");
const errResult = decodeEnvelope('{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["boom"],"num_turns":2,"duration_ms":5,"session_id":"s"}');
ok("error result", errResult instanceof ResultEvent && errResult.isError && errResult.errors.join() === "boom" && errResult.costUsd === 0 && errResult.result === "");
const unknownStream = decodeEnvelope('{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}}}');
ok("unknown stream event", unknownStream instanceof UnknownEvent && unknownStream.subtype === "message_delta");
const inputDelta = decodeEnvelope('{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\""}}}');
ok("input_json_delta ignored", inputDelta instanceof UnknownEvent && inputDelta.subtype === "input_json_delta");

// 3. Malformed input never throws.
ok("not json", decodeEnvelope("{not json") instanceof MalformedEvent);
ok("json number", decodeEnvelope("42") instanceof MalformedEvent);
ok("json null", decodeEnvelope("null") instanceof MalformedEvent);
ok("json array", decodeEnvelope("[1,2]") instanceof MalformedEvent);
ok("empty", decodeEnvelope("") instanceof MalformedEvent);

// 4. Line splitting across chunk boundaries, CRLF and multi-byte characters.
const splitter = new LineSplitter();
const a = splitter.push(Buffer.from('{"a":1}\r\n{"b":"hé', "utf8"));
const b = splitter.push(Buffer.from('llo"}\n\n{"c"', "utf8"));
const c = splitter.flush();
eq("split lines", a.concat(b, c).join("|"), '{"a":1}|{"b":"héllo"}|{"c"');
const euro = Buffer.from("€\n", "utf8");
const s2 = new LineSplitter();
const p1 = s2.push(euro.subarray(0, 1));
const p2 = s2.push(euro.subarray(1));
eq("split multibyte boundary", p1.concat(p2).join("|"), "€");

done();
