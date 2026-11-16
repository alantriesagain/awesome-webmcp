// The conversation's events decoded into their classes (conversation/event-types.ts): each type's
// fields read as the model reads them, the defaults a missing or wrongly typed field gets, and the
// null a non-object or an unknown type answers.
import { AtEvent, decodeEvent, InfoEvent, RequestEvent, ResultEvent, SessionEvent, TurnEvent } from "../src/conversation/event-types.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const at = decodeEvent({ type: "at", ms: 1234 });
ok("an at event is decoded", at instanceof AtEvent);
if (at instanceof AtEvent) eq("with its time", String(at.ms), "1234");
const noMs = decodeEvent({ type: "at" });
if (noMs instanceof AtEvent) eq("and a missing time is 0", String(noMs.ms), "0");

const session = decodeEvent({ type: "session", id: "s-1", model: "opus", cwd: "/p", mode: "plan", effort: "high", earlier: false, commands: ["/a", 7, "/b"] });
ok("a session event is decoded", session instanceof SessionEvent);
if (session instanceof SessionEvent) {
  eq("its fields", [session.id, session.model, session.cwd, session.mode, session.effort].join("|"), "s-1|opus|/p|plan|high");
  eq("a false earlier is read", String(session.hasEarlier) + " " + String(session.earlier), "true false");
  eq("commands keep the strings", session.commands !== null ? session.commands.join(",") : "null", "/a,/b");
}
const bare = decodeEvent({ type: "session" });
if (bare instanceof SessionEvent) {
  eq("missing fields fall back", [bare.id, bare.model, bare.cwd, bare.mode, bare.effort].join("|"), "||||");
  eq("an absent earlier is not read", String(bare.hasEarlier), "false");
  eq("absent commands stay unknown", bare.commands === null ? "null" : "some", "null");
}
const wrongCommands = decodeEvent({ type: "session", commands: "nope" });
if (wrongCommands instanceof SessionEvent) eq("commands of another type are empty", wrongCommands.commands !== null ? String(wrongCommands.commands.length) : "null", "0");

const turn = decodeEvent({ type: "turn", text: "hi", images: 2, notice: "yes", imagePaths: ["/i.png", 4] });
if (turn instanceof TurnEvent) {
  eq("a turn reads its fields", [turn.text, String(turn.images), turn.imagePaths.join(",")].join("|"), "hi|2|/i.png");
  eq("its prompt defaults true and notice needs true", String(turn.prompt) + " " + String(turn.notice), "true false");
}
const noPrompt = decodeEvent({ type: "turn", prompt: false });
if (noPrompt instanceof TurnEvent) eq("prompt false turns the prompt off", String(noPrompt.prompt), "false");

const result = decodeEvent({ type: "result", id: "c1", text: "done", images: 1, error: true, size: 9, truncated: "agent", patch: [{ oldStart: 2, newStart: 3, lines: ["-a", "+b"] }] });
ok("a result event is decoded", result instanceof ResultEvent);
if (result instanceof ResultEvent) {
  eq("its fields", [result.id, result.text, String(result.images), String(result.error), String(result.size), result.truncated].join("|"), "c1|done|1|true|9|agent");
  eq("its patch", String(result.patch !== null && result.patch.length) + " " + (result.patch !== null ? result.patch[0].lines.join(",") : ""), "1 -a,+b");
}
const noPatch = decodeEvent({ type: "result", size: "wide" });
if (noPatch instanceof ResultEvent) {
  eq("an absent patch stays unknown", noPatch.patch === null ? "null" : "some", "null");
  eq("a wrongly typed size is unknown but present", String(noPatch.size) + " " + String(noPatch.hasSize), "null true");
}

const info = decodeEvent({ type: "info", fields: { modelId: "opus", contextInput: 10, thinking: "much", cwd: 7 } });
if (info instanceof InfoEvent && info.fields !== null) {
  eq("info reads its fields", [info.fields.modelId, String(info.fields.contextInput), String(info.fields.thinking), String(info.fields.cwd)].join("|"), "opus|10|null|null");
}
const noFields = decodeEvent({ type: "info", fields: [] });
if (noFields instanceof InfoEvent) eq("info fields that are not an object stay null", noFields.fields === null ? "null" : "some", "null");

const request = decodeEvent({ type: "request", id: "r1", name: "Ask", callId: "c1", input: { a: 1 }, category: "question", questions: [{ question: "go?", header: "Go", multi: true, options: [{ label: "Yes", description: "do it" }, { label: "No" }] }] });
ok("a request event is decoded", request instanceof RequestEvent);
if (request instanceof RequestEvent) {
  eq("its request fields", [request.request.name, String(request.request.hasInput), String(request.request.permission)].join("|"), "Ask|true|false");
  eq("its questions", [request.request.questions[0].question, String(request.request.questions[0].multi), request.request.questions[0].options.map((o) => o.label + ":" + o.description).join(",")].join("|"), "go?|true|Yes:do it,No:");
}

eq("an unknown type decodes to null", decodeEvent({ type: "nope" }) === null ? "null" : "event", "null");
eq("a missing type decodes to null", decodeEvent({ text: "hi" }) === null ? "null" : "event", "null");
eq("a non-object decodes to null", [decodeEvent("at"), decodeEvent(null), decodeEvent([{ type: "at" }])].map((e) => e === null ? "null" : "event").join(","), "null,null,null");

done();
