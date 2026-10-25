// A model for tests and the selftest: scripted replies from a JSONL fixture, one record per
// reply: `{"match": "hello", "text": "Hello, world.", "thinking": "", "tools": [{"name": "Bash",
// "input": {"command": "ls"}}], "chunks": 2, "delayMs": 0, "hold": false, "error": "", "input":
// 10, "output": 3}`. A request takes the first unused record whose `match` is empty or the first
// word of the last user message's text (a tool result's text counts too: a record matching the
// word `result` answers the turn after a tool ran); with none left, it echoes "You said: <text>".
// `tools` makes the reply call them, its stop reason `tool_use`; `hold` keeps the stream open
// until it is aborted; `delayMs` waits between chunks so a message can arrive mid-turn.
import { readTextOr } from "@light/lib/fs.ts";
import { listOf, num, parseJson, recordOf, str } from "@light/lib/json.ts";
import { Abort } from "../loop/abort.ts";
import { ModelRequest, StreamEnd, StreamListener } from "./client.ts";
import { CANCELLED, END_TURN, FAILED, TOOL_RESULT, TOOL_USE } from "./message.ts";

export class FakeCall {
  readonly name: string;
  readonly inputJson: string;

  constructor(name: string, inputJson: string) {
    this.name = name;
    this.inputJson = inputJson;
  }
}

export class FakeReply {
  match = "";
  text = "";
  thinking = "";
  calls: FakeCall[] = [];
  chunks = 2;
  delayMs = 0;
  hold = false;
  error = "";
  input = 10;
  output = 3;
  used = false;
}

const wait = (ms: number): Promise<void> => new Promise<void>((settle) => setTimeout(() => settle(), ms));

export class FakeClient {
  readonly replies: FakeReply[] = [];
  private calls = 0;

  /** Replies from JSONL text, a record per line (a line that is not a record is skipped). */
  static fromText(text: string): FakeClient {
    const c = new FakeClient();
    for (const line of text.split("\n")) {
      const r = recordOf(parseJson(line));
      if (r === null) continue;
      const reply = new FakeReply();
      reply.match = str(r["match"]);
      reply.text = str(r["text"]);
      reply.thinking = str(r["thinking"]);
      for (const v of listOf(r["tools"])) {
        const t = recordOf(v);
        if (t !== null && str(t["name"]).length > 0) reply.calls.push(new FakeCall(str(t["name"]), JSON.stringify(t["input"] ?? {})));
      }
      reply.chunks = Math.max(1, num(r["chunks"], 2));
      reply.delayMs = num(r["delayMs"], 0);
      reply.hold = r["hold"] === true;
      reply.error = str(r["error"]);
      reply.input = num(r["input"], 10);
      reply.output = num(r["output"], 3);
      c.replies.push(reply);
    }
    return c;
  }

  static fromFile(path: string): FakeClient {
    return FakeClient.fromText(readTextOr(path, ""));
  }

  /** The reply for the last user message: the first unused record matching its first word (`result` for a tool result), else an echo. */
  private pick(last: string, afterTool: boolean): FakeReply {
    const word = afterTool ? "result" : (last.trim().split(/\s+/)[0] ?? "");
    for (const r of this.replies) {
      if (r.used || (r.match.length > 0 && r.match !== word)) continue;
      r.used = true;
      return r;
    }
    const echo = new FakeReply();
    echo.text = afterTool ? "Done: " + last.trim().slice(0, 60) : "You said: " + last.trim();
    return echo;
  }

  async play(req: ModelRequest, listener: StreamListener, abort: Abort): Promise<StreamEnd> {
    // A request naming a session (the naming prompt first in the system): one fixed answer.
    if (req.system.length > 0 && req.system[0].startsWith("You name coding sessions")) {
      const fn = listener.onText;
      if (fn !== null) fn("Fake session title");
      const named = new StreamEnd(END_TURN);
      named.usage.input = 20;
      named.usage.output = 3;
      return named;
    }
    const last = req.messages.length > 0 ? req.messages[req.messages.length - 1] : null;
    const afterTool = last !== null && last.parts.some((p) => p.kind === TOOL_RESULT);
    const lastText = last !== null ? (afterTool ? last.parts.map((p) => p.text).join("\n") : last.text()) : "";
    const reply = this.pick(lastText, afterTool);
    if (reply.error.length > 0) {
      const failed = new StreamEnd(FAILED);
      failed.error = reply.error;
      return failed;
    }
    if (reply.thinking.length > 0) {
      const fn = listener.onThinking;
      if (fn !== null) fn(reply.thinking);
    }
    const size = Math.max(1, Math.ceil(reply.text.length / reply.chunks));
    for (let at = 0; at < reply.text.length; at += size) {
      if (abort.aborted) return new StreamEnd(CANCELLED);
      if (at > 0 && reply.delayMs > 0) await wait(reply.delayMs);
      const fn = listener.onText;
      if (fn !== null) fn(reply.text.slice(at, at + size));
    }
    for (const c of reply.calls) {
      const id = "call_" + String(++this.calls);
      const start = listener.onToolCallStart;
      if (start !== null) start(id, c.name);
      const delta = listener.onToolCallDelta;
      if (delta !== null) delta(id, c.inputJson);
      const stop = listener.onToolCallEnd;
      if (stop !== null) stop(id);
    }
    while (reply.hold && !abort.aborted) await wait(20);
    if (abort.aborted) return new StreamEnd(CANCELLED);
    const end = new StreamEnd(reply.calls.length > 0 ? TOOL_USE : END_TURN);
    end.usage.input = reply.input;
    end.usage.output = reply.output;
    return end;
  }
}
