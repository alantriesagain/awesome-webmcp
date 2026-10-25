// The skills the agent has (a `skills` event) and the session's skill runs (skills.ts): a call of
// the skill category starts a run that counts the turn's calls after it until the next skill or the
// turn's end, where it stands following its call and the turn; a "command" notice naming a known
// skill with its slash starts a run too (one naming no skill does not); a skill loaded in a turn
// still open runs on.
import { ChatModel } from "../model.ts";
import { applyEvents } from "../events.ts";
import { StatusInfo } from "../status-info.ts";
import { skillRuns } from "../skills.ts";
import { done, eq } from "@light/test/assert.ts";

const model = new ChatModel();
const info = new StatusInfo();
const apply = (events: unknown[]): number => applyEvents(model, info, events);

eq("before the agent says", model.skillsKnown + " " + String(model.skills.length), "false 0");
apply([{ type: "skills", skills: [{ name: "alpha", description: "The first.", source: "project", path: "/p/.claude/skills/alpha/SKILL.md", command: "/alpha" }, { name: "beta" }, { name: "" }] }]);
eq("the skills, a nameless one left out", model.skills.map((s) => s.name + "|" + s.description + "|" + s.source + "|" + s.path + "|" + s.command).join(", "), "alpha|The first.|project|/p/.claude/skills/alpha/SKILL.md|/alpha, beta||||");
eq("known, and whole", String(model.skillsKnown) + " " + String(model.skillsPartial), "true false");
apply([{ type: "skills", skills: [{ name: "alpha" }], partial: true }]);
eq("a list found on disk before the agent said is partial", String(model.skills.length) + " " + String(model.skillsPartial), "1 true");
apply([{ type: "skills", skills: [{ name: "alpha", description: "The first.", source: "project", path: "/p/.claude/skills/alpha/SKILL.md", command: "/alpha" }, { name: "beta" }] }]);
eq("the agent's own list replaces it", String(model.skills.length) + " " + String(model.skillsPartial), "2 false");

const runs = (): string => skillRuns(model).map((r) => r.name + ":" + r.callId + ":" + r.state + ":" + String(r.calls) + ":" + String(r.startedMs) + "-" + String(r.endedMs)).join(" ");
apply([{ type: "at", ms: 1000 }, { type: "turn", text: "do alpha" }]);
eq("no run yet", runs(), "");
apply([
  { type: "at", ms: 1100 },
  { type: "block", key: "c1", kind: "tool", id: "c1", name: "Skill", category: "skill", summary: "alpha" },
  { type: "finish", key: "c1" },
]);
eq("the skill call starts a run, running with the turn", runs(), "alpha:c1:running:0:1100-0");
apply([
  { type: "at", ms: 1200 },
  { type: "result", id: "c1", text: "loaded" },
  { type: "block", key: "c2", kind: "tool", id: "c2", name: "Bash", category: "run", summary: "ls" },
  { type: "finish", key: "c2" },
  { type: "at", ms: 1300 },
  { type: "result", id: "c2", text: "a" },
  { type: "block", key: "c3", kind: "tool", id: "c3", name: "Read", category: "read", summary: "a" },
  { type: "finish", key: "c3" },
]);
eq("the calls after it count, the run still on", runs(), "alpha:c1:running:2:1100-0");
apply([
  { type: "at", ms: 1350 },
  { type: "result", id: "c3", text: "x" },
  { type: "at", ms: 1400 },
  { type: "block", key: "c4", kind: "tool", id: "c4", name: "Skill", category: "skill", summary: "beta" },
  { type: "finish", key: "c4" },
  { type: "at", ms: 1500 },
  { type: "result", id: "c4", text: "no such skill", error: true },
  { type: "block", key: "c5", kind: "tool", id: "c5", name: "Bash", category: "run", summary: "pwd" },
  { type: "finish", key: "c5" },
  { type: "at", ms: 1600 },
  { type: "result", id: "c5", text: "/p" },
]);
eq("another skill ends the first run where its latest call ended; one whose call failed is failed", runs(), "alpha:c1:done:2:1100-1350 beta:c4:failed:1:1400-1500");
apply([{ type: "at", ms: 2000 }, { type: "end", durationMs: 1000 }]);
eq("the turn's end leaves them", runs(), "alpha:c1:done:2:1100-1350 beta:c4:failed:1:1400-1500");

// A skill the user typed: the agent's "command" notice names it.
apply([{ type: "at", ms: 3000 }, { type: "turn", text: "/alpha now" }, { type: "notice", text: "/alpha now", tone: "command" }, { type: "notice", text: "/compact", tone: "command" }]);
eq("a typed skill is a run with no call, running while the turn is open; a command that is no skill is not", runs(), "alpha:c1:done:2:1100-1350 beta:c4:failed:1:1400-1500 alpha::running:0:3000-0");
apply([
  { type: "at", ms: 3100 },
  { type: "block", key: "c6", kind: "tool", id: "c6", name: "Bash", category: "run", summary: "ls" },
  { type: "finish", key: "c6" },
  { type: "result", id: "c6", text: "a" },
  { type: "at", ms: 3500 },
  { type: "end", durationMs: 500 },
]);
eq("done with the turn, ended where its last call did", runs(), "alpha:c1:done:2:1100-1350 beta:c4:failed:1:1400-1500 alpha::done:1:3000-3100");

// A typed skill whose turn made no call ends when the turn did.
apply([{ type: "at", ms: 4000 }, { type: "turn", text: "/beta" }, { type: "notice", text: "/beta", tone: "command" }, { type: "at", ms: 4200 }, { type: "end", durationMs: 200 }]);
eq("ended with the turn", skillRuns(model).slice(-1).map((r) => r.name + ":" + r.state + ":" + String(r.endedMs)).join(""), "beta:done:4200");

done();
