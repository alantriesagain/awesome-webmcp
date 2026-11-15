// The model's own rules: a child update invalidates the card above it, an event for an unknown
// parent opens no turn, a request is made once, a taken message bumps the model, and one call
// state serves the views.
import { ChatModel, Item, TaskInfo, ToolResult, AGENT, TEXT, TOOL } from "../src/conversation/model.ts";
import { RenderContext, itemLines } from "../src/conversation/render.ts";
import { applyEvents, applySubagentEvents } from "../src/conversation/events.ts";
import { StatusInfo } from "../src/conversation/status-info.ts";
import { agentStatus } from "../src/conversation/agents.ts";
import { callState, FAILED } from "../src/conversation/calls.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const textOf = (lines: ReturnType<typeof itemLines>): string => lines.map((l) => l.runs.map((r) => r.text).join("")).join("\n");

const main = async (): Promise<void> => {
  // A subagent's card is drawn from its children; a child change must reach the card's cache.
  const m = new ChatModel();
  m.openTurn("go", 0, true);
  const call = m.block("", "call-1", TOOL, "toolu-1", "Agent", "");
  ok("the call is made", call !== null);
  if (call === null) return;
  call.category = AGENT;
  const child = m.block(call.id, "text-1", TEXT, "", "text", "first");
  ok("the child is under the call", child !== null);
  if (child === null) return;
  const ctx = new RenderContext();
  ctx.agent = "Claude";
  const before = textOf(itemLines(call, ctx, [], 80));
  const revision = call.rev;
  child.text = "second";
  m.touch(child);
  const after = textOf(itemLines(call, ctx, [], 80));
  ok("a child update bumps the card's revision", call.rev > revision);
  ok("and the card is drawn again", before !== after && after.includes("second"));
  m.closeTurn(null);

  // A late event for a call the turn no longer holds does not open a turn of its own.
  const late = new ChatModel();
  const one = late.openTurn("go", 0, true);
  late.closeTurn(null);
  const turns = late.turns.length;
  ok("an unknown parent makes no block", late.block("missing", "k", TEXT, "", "text", "late") === null);
  eq("and opens no turn", String(late.turns.length), String(turns));
  void one;

  // A repeated request keeps the item it opened.
  const asked = new ChatModel();
  asked.openTurn("ask", 0, true);
  const first = asked.openRequest("r-1", "Ask", "call-1", null);
  const second = asked.openRequest("r-1", "Ask", "call-1", null);
  ok("a repeated request is the same item", first === second);
  eq("and is open once", String(asked.openRequests().length), "1");
  asked.closeTurn(null);
  asked.openTurn("ask again", 0, true);
  ok("a request of an earlier turn is new again", asked.openRequest("r-1", "Ask", "call-1", null) !== first);
  asked.closeTurn(null);
  const old = asked.openRequest("r-2", "Ask", "call-2", null);
  asked.openTurn("next", 0, true);
  asked.openTurn("next again", 0, true);
  ok("a request of an earlier turn is forgotten", asked.openRequest("r-2", "Ask", "call-2", null) !== old);
  asked.closeTurn(null);

  // The app's own request with no turn open (the onboarding's): after the last turn, no turn opened, nothing running.
  const idle = new ChatModel();
  const own = idle.openRequest("ask1", "Trust", "", null);
  ok("an idle request opens no turn and runs nothing", idle.current === null && !idle.running && idle.turns.length === 1 && idle.turns[0].notes);
  ok("it sits after the turn, open", idle.turns[0].after.children.includes(own) && idle.openRequests().length === 1);
  idle.openTurn("go", 0, true);
  idle.closeTurn(null);
  ok("and stays open through a later turn's close", own.state === "open" && idle.openRequests().includes(own));
  idle.settle("ask1", "answered");
  ok("until answered, nothing running then either", own.state === "answered" && idle.openRequests().length === 0 && !idle.running);

  // Taking a queued message moves what the chat draws.
  const queue = new ChatModel();
  queue.send("hello", 0);
  const queuedVersion = queue.version.peek();
  queue.take("hello", []);
  ok("a taken message bumps the model", queue.version.peek() > queuedVersion && queue.pending.length === 0);

  // Unknown events are not counted as applied.
  const info = new StatusInfo();
  eq("an unknown event is not applied", String(applyEvents(queue, info, [{ type: "nope" }])), "0");
  eq("a known one is", String(applyEvents(queue, info, [{ type: "notice", text: "said" }])), "1");

  // One call state for every view: a failed task wins over a non-error result.
  const failed = new Item(TOOL, "call-2");
  failed.category = AGENT;
  const task = new TaskInfo();
  task.status = "failed";
  failed.task = task;
  const result = new ToolResult();
  failed.result = result;
  eq("a failed task is failed, not done", callState(failed) + " " + agentStatus(failed), FAILED + " failed");

  const long = new ChatModel();
  for (let i = 0; i < 1001; i++) long.openTurn("turn " + String(i), 0, true);
  eq("a long session keeps the newest turns", String(long.turns.length) + " " + String(long.earlier), "1000 true");

  // A subagent's events apply under its call, and stop when the turn closes.
  const sub = new ChatModel();
  sub.openTurn("main", 0, true);
  const subTask = sub.block("", "tc", TOOL, "toolu-sub", "Task", "");
  ok("the Task call is made", subTask !== null);
  if (subTask !== null) {
    subTask.category = AGENT;
    eq("a subagent's block and text go under the call", String(applySubagentEvents(sub, subTask.id, [{ type: "block", key: "s1", kind: "text", text: "hello" }, { type: "text", parent: subTask.id, key: "s1", delta: " world" }])), "2");
    ok("the words are the subagent's, in its call", subTask.children.length === 1 && subTask.children[0].text === "hello world");
  }
  sub.closeTurn(null);
  eq("after the turn closes, nothing applies", String(applySubagentEvents(sub, "toolu-sub", [{ type: "notice", text: "later" }])), "0");
  ok("and the main turn took no notice", sub.turns[0].body.children.filter((i) => i.kind === 4).length === 0);

  // A run's own facts make the Task call count as a subagent in the conversation's status; its
  // inner read stays out of the main counts.
  const run = new ChatModel();
  run.openTurn("main", 0, true);
  const runCard = run.block("", "tc-run", TOOL, "toolu-run", "Task", "");
  ok("the run's Task call is made", runCard !== null);
  const runInfo = new StatusInfo();
  if (runCard !== null) {
    eq("the call's facts and its inner read apply", String(applySubagentEvents(run, "toolu-run", [
      { type: "facts", id: "toolu-run", category: "agent", summary: "agent: look", agentType: "agent", agentTask: "look" },
      { type: "block", key: "r1", kind: "tool", id: "read-1", name: "Read", text: "", category: "read", summary: "a.ts" },
    ], false, runInfo)), "2");
  }
  eq("the main status counts the call as a subagent", String(runInfo.agents), "1");
  eq("and not the subagent's own read", String(runInfo.reads), "0");

  // A historical read-back does not count the call again, since the history load already did.
  const reread = new ChatModel();
  reread.openTurn("main", 0, true);
  const rereadCard = reread.block("", "tc-h", TOOL, "toolu-h", "Task", "");
  const rereadInfo = new StatusInfo();
  applyEvents(reread, rereadInfo, [{ type: "facts", id: "toolu-h", category: "agent", summary: "agent: look" }]);
  eq("the history load counts the call as a subagent", String(rereadInfo.agents), "1");
  if (rereadCard !== null) applySubagentEvents(reread, "toolu-h", [{ type: "facts", id: "toolu-h", category: "agent", summary: "agent: look" }], true, rereadInfo);
  eq("a historical read does not count it again", String(rereadInfo.agents), "1");

  const hist = new ChatModel();
  hist.openTurn("main", 0, true);
  const past = hist.block("", "tc2", TOOL, "toolu-hist", "Task", "");
  if (past !== null) past.category = AGENT;
  hist.closeTurn(null);
  eq("a historical transcript applies to a closed call", String(past !== null ? applySubagentEvents(hist, "toolu-hist", [{ type: "notice", text: "past" }], true) : 0), "1");

  const under = new ChatModel();
  under.openTurn("main", 0, true);
  const parent = under.block("", "tc2", TOOL, "toolu-under", "Task", "");
  const request = parent !== null ? under.openRequest("r-under", "Ask", "", null, parent.id) : null;
  ok("a request with a parent opens under that call", parent !== null && request !== null && parent.children.includes(request) && request.turn === parent.turn);
  under.closeTurn(null);

  // A background run's question survives its card's turn closing; the run's own end withdraws it.
  const bgm = new ChatModel();
  bgm.openTurn("main", 0, true);
  const bgCard = bgm.block("", "tc-bg", TOOL, "toolu-bg", "Task", "");
  ok("the background Task call is made", bgCard !== null);
  if (bgCard !== null) {
    const bgInfo = new TaskInfo();
    bgInfo.taskId = "toolu-bg";
    bgInfo.background = true;
    bgm.startTask("toolu-bg", bgInfo);
    const bgAsk = bgm.openRequest("r-bg", "Ask", "", null, bgCard.id);
    bgm.closeTurn(null);
    ok("a background run's question stays open as its turn closes", bgAsk.state === "open" && bgm.openRequests().includes(bgAsk));
    bgm.openTurn("again", 0, true);
    applyEvents(bgm, new StatusInfo(), [{ type: "taskUpdate", id: "toolu-bg", taskId: "toolu-bg", status: "stopped" }]);
    ok("and its end withdraws the question", bgAsk.state === "cancelled" && bgm.openRequests().length === 0);
  }

  // A foreground request still goes with its turn.
  const fgm = new ChatModel();
  fgm.openTurn("main", 0, true);
  const fgAsk = fgm.openRequest("r-fg", "Ask", "", null);
  fgm.closeTurn(null);
  eq("a foreground request closes with its turn", fgAsk.state, "cancelled");

  // A result's size and who cut it are kept, from the event or from widecode's note in the text,
  // and a large cut result says both on its card's line while a small one adds nothing.
  const sized = new ChatModel();
  sized.openTurn("go", 0, true);
  const sizedCall = sized.block("", "tc-size", TOOL, "toolu-size", "Bash", "");
  ok("the sized call is made", sizedCall !== null);
  if (sizedCall !== null) {
    applyEvents(sized, new StatusInfo(), [{ type: "result", id: "toolu-size", text: "x", size: 48000, truncated: "agent" }]);
    ok("a result keeps its event's size and cut", sizedCall.result !== null && sizedCall.result.size === 48000 && sizedCall.result.truncated === "agent");
    const card = textOf(itemLines(sizedCall, new RenderContext(), [], 80));
    ok("a large cut result shows its size and who cut it", card.includes("48k chars") && card.includes("cut by the agent"));
  }
  const noted = new ChatModel();
  noted.openTurn("go", 0, true);
  const notedCall = noted.block("", "tc-note", TOOL, "toolu-note", "Bash", "");
  ok("the noted call is made", notedCall !== null);
  if (notedCall !== null) {
    const note = "[widecode cut this result: it was 50000 characters, over the 40000 it returns to an agent.]";
    applyEvents(noted, new StatusInfo(), [{ type: "result", id: "toolu-note", text: "H".repeat(30000) + "\n\n" + note + "\n\nT".repeat(8000) }]);
    ok("widecode's note is read back as its cut and the full size", notedCall.result !== null && notedCall.result.truncated === "widecode" && notedCall.result.size === 50000);
    const card = textOf(itemLines(notedCall, new RenderContext(), [], 80));
    ok("the card shows both parts", card.includes("50k chars") && card.includes("cut by widecode"));
  }
  const small = new ChatModel();
  small.openTurn("go", 0, true);
  const smallCall = small.block("", "tc-small", TOOL, "toolu-small", "Bash", "");
  ok("the small call is made", smallCall !== null);
  if (smallCall !== null) {
    applyEvents(small, new StatusInfo(), [{ type: "result", id: "toolu-small", text: "a.txt" }]);
    const card = textOf(itemLines(smallCall, new RenderContext(), [], 80));
    ok("a small result adds nothing to its card", smallCall.result !== null && smallCall.result.size === 5 && !card.includes("chars") && !card.includes("cut by"));
  }

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
