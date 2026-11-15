// ffi: @lightstart/plugins/native/ffi.json
// The todo plugin over the harness: add, add, toggle and list over the fake model, the details kept
// in the session file's outcome, a fresh agent loading the session again and rebuilding the list
// from its branch, an add with no text and a toggle of an unknown id as error results that leave
// the list as it was, the /todos command, and config.json's switch turning the plugin off.
import { readFileSync } from "node:fs";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { SessionStore } from "../src/harness/session/store.ts";
import { AgentRig, toolTextOf, until } from "./support/agent-rig.ts";

const FIXTURE = [
  '{"match":"addone","text":"Adding.","tools":[{"name":"todo","input":{"action":"add","text":"write tests"}}]}',
  '{"match":"result","text":"Added."}',
  '{"match":"addtwo","text":"Adding.","tools":[{"name":"todo","input":{"action":"add","text":"ship it"}}]}',
  '{"match":"result","text":"Added."}',
  '{"match":"toggle","text":"Toggling.","tools":[{"name":"todo","input":{"action":"toggle","id":1}}]}',
  '{"match":"result","text":"Toggled."}',
  '{"match":"list","text":"Listing.","tools":[{"name":"todo","input":{"action":"list"}}]}',
  '{"match":"result","text":"Listed."}',
  '{"match":"badadd","text":"Adding.","tools":[{"name":"todo","input":{"action":"add"}}]}',
  '{"match":"result","text":"Failed."}',
  '{"match":"badtoggle","text":"Toggling.","tools":[{"name":"todo","input":{"action":"toggle","id":99}}]}',
  '{"match":"result","text":"Failed."}',
  '{"match":"list","text":"Listing.","tools":[{"name":"todo","input":{"action":"list"}}]}',
  '{"match":"result","text":"Listed."}',
].join("\n");

const LIST = "[x] 1 write tests\n[ ] 2 ship it";

const main = async (): Promise<void> => {
  {
    const rig = new AgentRig(FIXTURE, ["todo"]);
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();

    await rig.prompt(sid, "addone");
    eq("the first add answers one item", toolTextOf(rig.taken()), "[ ] 1 write tests");
    await rig.prompt(sid, "addtwo");
    eq("the second add follows it", toolTextOf(rig.taken()), "[ ] 1 write tests\n[ ] 2 ship it");

    const file = new SessionStore(rig.paths!.sessionsDir(rig.folder)).pathOf(sid);
    const kept = readFileSync(file, "utf8");
    ok("the details are in the session file's outcome", kept.includes("detailsJson") && kept.includes("write tests") && kept.includes("ship it"));

    await rig.prompt(sid, "toggle");
    eq("toggle marks the item done", toolTextOf(rig.taken()), LIST);
    await rig.prompt(sid, "list");
    eq("list answers the items", toolTextOf(rig.taken()), LIST);

    await rig.prompt(sid, "/todos");
    const note = await rig.uiNotification("notify");
    eq("the command notifies the list", String(note["message"]), LIST);

    await rig.prompt(sid, "badadd");
    ok("an add with no text is an error result", toolTextOf(rig.taken()).includes("needs text"));
    await rig.prompt(sid, "badtoggle");
    ok("a toggle of an unknown id is an error result", toolTextOf(rig.taken()).includes("No todo with id 99."));
    await rig.prompt(sid, "list");
    eq("the failures leave the list as it was", toolTextOf(rig.taken()), LIST);

    rig.taken();
    rig.reopen(["todo"], '{"match":"again","text":"Hi."}');
    rig.initialize(true);
    const loading = rig.load(sid);
    await until(() => rig.out.some((line) => line.includes('"id":' + loading + ",")));
    await new Promise<void>((settle) => setTimeout(settle, 50));
    rig.taken();
    await rig.prompt(sid, "/todos");
    const rebuilt = await rig.uiNotification("notify");
    eq("a fresh agent rebuilds the list from the branch", String(rebuilt["message"]), LIST);
    rig.close();
  }

  // config.json switches the plugin off.
  {
    const rig = new AgentRig(FIXTURE, ["todo"]);
    rig.configure({ plugins: { todo: false } });
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "addone");
    const turn = toolTextOf(rig.taken());
    ok("a plugin switched off leaves the tool out", turn.includes("no tool named todo") && !turn.includes("write tests"));
    rig.close();
  }

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
