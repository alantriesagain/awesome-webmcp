// ffi: @lightstart/plugins/native/ffi.json
// The permission-gate plugin's agent part over the harness: a Bash command matching a pattern asks
// to be run, a yes lets it run and a no blocks it with the pattern in the reason; with no UI it
// blocks without asking; a harmless command passes without a question; the settings' patterns
// replace the defaults; and config.json's switch turns the plugin off.
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { AgentRig, toolTextOf } from "./support/agent-rig.ts";

const FIXTURE = [
  '{"match":"danger","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo rm -rf x"}}]}',
  '{"match":"result","text":"Ran."}',
  '{"match":"danger","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo rm -rf y"}}]}',
  '{"match":"result","text":"Ran."}',
  '{"match":"harmless","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo hello"}}]}',
  '{"match":"result","text":"Done."}',
  '{"match":"settings","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo KILLME"}}]}',
  '{"match":"result","text":"Done."}',
  '{"match":"danger","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo rm -rf z"}}]}',
  '{"match":"result","text":"Ran."}',
  '{"match":"danger","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo rm -rf w"}}]}',
  '{"match":"result","text":"Ran."}',
].join("\n");

const main = async (): Promise<void> => {
  // A yes runs the command; a no blocks it with the pattern named.
  {
    const rig = new AgentRig(FIXTURE, ["permission-gate"]);
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    const asked = rig.prompt(sid, "danger");
    const dialog = await rig.uiRequest("confirm");
    eq("the question is the plugin's", String(dialog.params["title"]), "Run this command?");
    eq("and it shows the command", String(dialog.params["message"]), "echo rm -rf x");
    rig.respond(dialog.id, { confirmed: true });
    await asked;
    ok("a confirmed dangerous command runs", toolTextOf(rig.taken()).includes("rm -rf x"));
    const refused = rig.prompt(sid, "danger");
    const again = await rig.uiRequest("confirm");
    eq("the second command is shown", String(again.params["message"]), "echo rm -rf y");
    rig.respond(again.id, { confirmed: false });
    await refused;
    const blocked = toolTextOf(rig.taken());
    ok("a refused command is blocked, its reason naming the pattern", blocked.includes("blocked by") && blocked.includes("rm -rf"));
    await rig.prompt(sid, "harmless");
    const harmless = rig.taken();
    ok("a harmless command runs", toolTextOf(harmless).includes("hello"));
    ok("and asks nothing", !harmless.some((line) => line.includes("_lightcode/ui")));
    rig.close();
  }

  // No UI: the dangerous command is blocked instead of asked.
  {
    const rig = new AgentRig(FIXTURE, ["permission-gate"]);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "danger");
    const turn = rig.taken();
    const text = toolTextOf(turn);
    ok("with no UI a dangerous command is blocked, the reason naming the pattern", text.includes("blocked by") && text.includes("rm -rf"));
    ok("and no dialog was sent", !turn.some((line) => line.includes("_lightcode/ui")));
    rig.close();
  }

  // The settings' patterns replace the defaults.
  {
    const rig = new AgentRig(FIXTURE, ["permission-gate"]);
    rig.configure({ plugins: { "permission-gate": { patterns: ["KILLME"] } } });
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "danger");
    const free = rig.taken();
    ok("a default pattern passes when the settings replace them", toolTextOf(free).includes("rm -rf x") && !free.some((line) => line.includes("_lightcode/ui")));
    const asked = rig.prompt(sid, "settings");
    const dialog = await rig.uiRequest("confirm");
    eq("a settings pattern is asked", String(dialog.params["message"]), "echo KILLME");
    rig.respond(dialog.id, { confirmed: false });
    await asked;
    ok("and refused, its reason naming it", toolTextOf(rig.taken()).includes("KILLME"));
    rig.close();
  }

  // config.json switches the plugin off.
  {
    const rig = new AgentRig(FIXTURE, ["permission-gate"]);
    rig.configure({ plugins: { "permission-gate": false } });
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "danger");
    const turn = rig.taken();
    ok("a plugin switched off lets the command through", toolTextOf(turn).includes("rm -rf x") && !turn.some((line) => line.includes("_lightcode/ui")));
    rig.close();
  }

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
