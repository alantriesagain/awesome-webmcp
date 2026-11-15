// ffi: @lightstart/plugins/native/ffi.json
// The tools-switch plugin over the harness: /tools off Bash leaves the next request without Bash,
// /tools lists every tool with its state, /tools reset turns them all on, the choice is kept in a
// custom entry that a fresh agent loading the session restores, and an unknown name is answered
// with a notification saying so.
import { readFileSync } from "node:fs";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { SessionStore } from "../src/harness/session/store.ts";
import { AgentRig, until } from "./support/agent-rig.ts";

const FIXTURE = [
  '{"match":"afteroff","text":"Done."}',
  '{"match":"afterreset","text":"Done."}',
  '{"match":"afterload","text":"Done."}',
].join("\n");

/** The tool names the last request offered. */
const names = (rig: AgentRig): string[] => {
  const asks = rig.asks();
  return (JSON.parse(asks[asks.length - 1].toolsJson) as { name: string }[]).map((t) => t.name);
};

const main = async (): Promise<void> => {
  const rig = new AgentRig(FIXTURE, ["tools-switch"]);
  rig.initialize(true);
  const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
  rig.taken();

  await rig.prompt(sid, "/tools off Bash");
  eq("switching Bash off is said", String((await rig.uiNotification("notify"))["message"]), "Bash is off.");
  await rig.prompt(sid, "afteroff");
  const off = names(rig);
  ok("the next request leaves Bash out", !off.includes("Bash") && off.includes("Read"));

  await rig.prompt(sid, "/tools");
  const list = String((await rig.uiNotification("notify"))["message"]);
  ok("the listing says every tool's state", list.includes("Bash: off") && list.includes("Read: on") && list.includes("\n"));
  eq("every tool is listed, Bash among them", String(list.split("\n").length), String(off.length + 1));

  await rig.prompt(sid, "/tools reset");
  eq("reset says every tool is on", String((await rig.uiNotification("notify"))["message"]), "Every tool is on.");
  await rig.prompt(sid, "afterreset");
  ok("the next request offers Bash again", names(rig).includes("Bash"));

  await rig.prompt(sid, "/tools off Read");
  await rig.uiNotification("notify");
  const kept = readFileSync(new SessionStore(rig.paths!.sessionsDir(rig.folder)).pathOf(sid), "utf8");
  ok("the choice is a custom entry in the session file", kept.includes('"customType":"tools-switch"') && kept.includes('"active"'));

  rig.taken();
  rig.reopen(["tools-switch"], FIXTURE);
  rig.initialize(true);
  const loading = rig.load(sid);
  await until(() => rig.out.some((line) => line.includes('"id":' + loading + ",")));
  await new Promise<void>((settle) => setTimeout(settle, 50));
  rig.taken();
  await rig.prompt(sid, "afterload");
  const restored = names(rig);
  ok("a fresh agent restores the choice", !restored.includes("Read") && restored.includes("Bash"));
  await rig.prompt(sid, "/tools");
  ok("the listing after the load says Read is off", String((await rig.uiNotification("notify"))["message"]).includes("Read: off"));

  await rig.prompt(sid, "/tools off Nope");
  eq("an unknown name is answered with a notification saying so", String((await rig.uiNotification("notify"))["message"]), "No tool named Nope.");
  rig.close();
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
