// Compaction's pieces: the threshold from the window and the setting; the cut point (the kept
// tail starts at the user's own words, a call and its result never split, the last turn kept whole
// when it alone passes the budget, nothing kept with a budget of 0); the transcript the model
// summarizes (thinking left out, a long result cut, the earlier summary first); the summary as the
// request's first user message; the context's size after; a compaction over the fake model.
import { Abort } from "../src/harness/loop/abort.ts";
import { KEEP_TOKENS, RESERVE_TOKENS, compactThreshold, contextAfter, cutPoint, summarize, transcriptText, withSummary } from "../src/harness/loop/compact.ts";
import { AgentLoop, LoopSession } from "../src/harness/loop/loop.ts";
import { estimateTokens, messageTokens } from "../src/harness/loop/tokens.ts";
import { ModelClient } from "../src/harness/model/client.ts";
import { FakeClient } from "../src/harness/model/fake.ts";
import { Message, Part, THINKING, TOOL_CALL, TOOL_RESULT, textPart } from "../src/harness/model/message.ts";
import { Auth } from "../src/harness/auth.ts";
import { registryFor } from "../src/harness/cli.ts";
import { HarnessConfig } from "../src/harness/config.ts";
import { ToolSet, builtInTools } from "../src/harness/tools/tool.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const user = (id: string, text: string): Message => {
  const m = new Message("user", id);
  m.parts.push(textPart(text));
  return m;
};
const assistant = (id: string, text: string, call: string): Message => {
  const m = new Message("assistant", id);
  const t = new Part(THINKING);
  t.text = "Thinking hard about it.";
  m.parts.push(t, textPart(text));
  if (call.length > 0) {
    const c = new Part(TOOL_CALL);
    c.callId = call;
    c.name = "Read";
    c.inputJson = '{"file_path":"a.txt"}';
    m.parts.push(c);
  }
  return m;
};
const results = (id: string, call: string, text: string): Message => {
  const m = new Message("user", id);
  const r = new Part(TOOL_RESULT);
  r.callId = call;
  r.text = text;
  m.parts.push(r);
  return m;
};

eq("the threshold: the window less the reserve, or the setting when lower", [compactThreshold(200000, 200000), compactThreshold(1000000, 200000), compactThreshold(100000, 200000)].join(","), String(200000 - RESERVE_TOKENS) + ",200000," + String(100000 - RESERVE_TOKENS));
eq("four characters to a token, a message a few more", String(estimateTokens("abcdefgh")) + " " + String(messageTokens(user("u", "abcdefgh"))), "2 6");

const long = "x".repeat(400);
const conversation = [user("u1", "first " + long), assistant("m1", "Reading.", "call_1"), results("u2", "call_1", long), assistant("m2", "Done reading.", ""), user("u3", "second"), assistant("m3", "Sure.", ""), user("u4", "third " + long), assistant("m4", "Ok.", "")];
eq("the tail within the budget starts at the user's own words", String(cutPoint(conversation, 200)), "4");
eq("a bigger budget that reaches a results message, not the words before it, starts after it", String(cutPoint(conversation, 300)), "4");
eq("a budget holding everything keeps everything", String(cutPoint(conversation, KEEP_TOKENS)), "0");
eq("a tail bigger than the budget keeps the last turn whole", String(cutPoint(conversation, 10)), "6");
eq("a budget of 0 keeps nothing", String(cutPoint(conversation, 0)), "8");
eq("a conversation ending in a batch keeps from the turn's words", String(cutPoint(conversation.slice(0, 3), 50)), "0");

const transcript = transcriptText("Earlier: the user wanted a.txt read.", [user("u1", "read it"), assistant("m1", "Reading.", "call_1"), results("u2", "call_1", "y".repeat(2100)), assistant("m2", "Done.", "")]);
ok("the earlier summary first, the words, the call and its result, no thinking", transcript.startsWith("<earlier_summary>\nEarlier: the user wanted a.txt read.\n</earlier_summary>\n<user>\nread it\n</user>\n<assistant>\nReading.\n</assistant>\n<tool_call name=\"Read\">{\"file_path\":\"a.txt\"}</tool_call>\n<tool_result>\n" + "y".repeat(2000) + "\n[cut]\n</tool_result>\n<assistant>\nDone.\n</assistant>") && !transcript.includes("Thinking"));

const sent = withSummary("The summary.", [user("u5", "next")]);
eq("the request's messages: the summary as the user's first message, the kept ones after", sent.map((m) => m.role + ":" + m.text()).join(" | "), "user:The conversation so far was compacted into this summary. Continue from it.\n\nThe summary. | user:next");
eq("no summary, the messages as they are", String(withSummary("", [user("u5", "next")]).length), "1");
eq("the context after: the summary's share and the kept messages", String(contextAfter("abcdefgh", [user("u5", "next")])), String(2 + 24 + 4 + 1));

const main = async (): Promise<void> => {
  const config = new HarnessConfig();
  const registry = registryFor(config, true);
  const client = new ModelClient(registry, new Auth("/nonexistent/auth.json"), "node", FakeClient.fromText(""));
  const got = await summarize(client, "fake/fake", "", conversation.slice(0, 4), "the file names", new Abort());
  eq("a summary from the model, the hint passed on", got.join(" | "), "Goal\nA fake summary of 1 user messages. Hint: the file names | ");

  const loop = new AgentLoop(client, new ToolSet(builtInTools()));
  const s = new LoopSession();
  s.model = "fake/fake";
  s.messages = conversation.slice();
  s.noteContext(5000);
  const c = await loop.compactContext(s, 200, "", new Abort());
  ok("a compaction: the messages before the tail summarized, the tail kept, the first kept message named, the sizes", c !== null && c.error.length === 0 && c.firstKeptId === "u3" && c.tokensBefore === 5000 && c.tokensAfter === contextAfter(s.summary, s.messages) && s.messages.map((m) => m.id).join(",") === "u3,m3,u4,m4" && s.summary.startsWith("Goal\nA fake summary of 1 user messages."));
  const again = await loop.compactContext(s, 0, "", new Abort());
  ok("another with nothing kept folds the earlier summary in", again !== null && again.firstKeptId === "" && s.messages.length === 0 && s.summary.includes("An earlier summary was folded in."));
  ok("nothing before the tail: no compaction", (await loop.compactContext(s, KEEP_TOKENS, "", new Abort())) === null);
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
