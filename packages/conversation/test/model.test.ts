// The model's own rules: a child update invalidates the card above it, an event for an unknown
// parent opens no turn, a request is made once, a taken message bumps the model, and one call
// state serves the views.
import { ChatModel, Item, TaskInfo, ToolResult, AGENT, TEXT, TOOL } from "../model.ts";
import { RenderContext, itemLines } from "../render.ts";
import { applyEvents } from "../events.ts";
import { StatusInfo } from "../status-info.ts";
import { agentStatus } from "../agents.ts";
import { callState, FAILED } from "../calls.ts";
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

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
