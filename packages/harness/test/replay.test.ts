// A loaded conversation shown again: a user message as one chunk with its id, the agent's text and
// thinking as chunks with theirs, a tool call as one completed call carrying the kind, input, files,
// text and change its result kept, a call without a kept result shown as failed, a results message
// shown as nothing; the lines paced through the sink.
import { Message, Part, THINKING, TOOL_CALL, TOOL_RESULT, textPart } from "../model/message.ts";
import { replayPaced, replayUpdates } from "../session/replay.ts";
import { ToolOutcome } from "../tools/tool.ts";
import { done, eq } from "@light/test/assert.ts";

const user = new Message("user", "u1");
user.parts.push(textPart("edit a.txt"));
const assistant = new Message("assistant", "m1");
const thought = new Part(THINKING);
thought.text = "Editing it.";
const edit = new Part(TOOL_CALL);
edit.callId = "call_1";
edit.name = "Edit";
edit.inputJson = '{"file_path":"a.txt","old_string":"one","new_string":"two"}';
const lost = new Part(TOOL_CALL);
lost.callId = "call_2";
lost.name = "Bash";
lost.inputJson = '{"command":"ls"}';
assistant.parts.push(thought, textPart("On it."), edit, lost);
const results = new Message("user", "u2");
const r = new Part(TOOL_RESULT);
r.callId = "call_1";
const o = new ToolOutcome();
o.text = "edited a.txt";
o.locations = ["/p/a.txt"];
o.diffPath = "/p/a.txt";
o.oldText = "one\n";
o.newText = "two\n";
o.patch = "@@ -1,1 +1,1 @@\n-one\n+two\n";
o.rawOutputJson = '{"metadata":{"filediff":{"patch":"@@ -1,1 +1,1 @@\\n-one\\n+two\\n"}}}';
r.acpJson = o.json("edit");
results.parts.push(r);
const reply = new Message("assistant", "m2");
reply.parts.push(textPart("Done."));

const lines = replayUpdates("s1", [user, assistant, results, reply]);
eq("one line per thing shown", String(lines.length), "6");
eq("the user's message, with its id", lines[0], '{"sessionId":"s1","update":{"sessionUpdate":"user_message_chunk","messageId":"u1","content":{"type":"text","text":"edit a.txt"}}}');
eq("the thought", lines[1], '{"sessionId":"s1","update":{"sessionUpdate":"agent_thought_chunk","messageId":"m1","content":{"type":"text","text":"Editing it."}}}');
eq("the text", lines[2], '{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","messageId":"m1","content":{"type":"text","text":"On it."}}}');
eq(
  "the edit as one completed call: the kind, input, file, text, the diff and the raw output its result kept",
  lines[3],
  '{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"call_1","title":"Edit","kind":"edit","status":"completed","rawInput":{"file_path":"a.txt","old_string":"one","new_string":"two"},"locations":[{"path":"/p/a.txt"}],"content":[{"type":"content","content":{"type":"text","text":"edited a.txt"}},{"type":"diff","path":"/p/a.txt","oldText":"one\\n","newText":"two\\n"}],"rawOutput":{"metadata":{"filediff":{"patch":"@@ -1,1 +1,1 @@\\n-one\\n+two\\n"}}}}}',
);
eq("a call whose result was not kept is shown failed", lines[4], '{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"call_2","title":"Bash","kind":"other","status":"failed","rawInput":{"command":"ls"},"locations":[],"content":[{"type":"content","content":{"type":"text","text":"no result kept"}}]}}');
eq("the reply", lines[5], '{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","messageId":"m2","content":{"type":"text","text":"Done."}}}');

const many: string[] = [];
for (let i = 0; i < 450; i++) many.push(String(i));
const heard: string[] = [];
replayPaced(many, (l: string) => heard.push(l)).then(() => {
  eq("every line through the sink, in order, across the pauses", heard.length + " " + heard[0] + " " + heard[449], "450 0 449");
  done();
});
