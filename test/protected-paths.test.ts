// ffi: @lightstart/plugins/native/ffi.json
// The protected-paths plugin's agent part over the harness: a Write or Edit of .env, .env.*, a path
// under .git/ or node_modules/ is blocked, its reason naming the rule; an ordinary file is allowed;
// a Bash redirect into such a path and an rm of one are blocked too; the settings' paths replace
// the defaults; and config.json's switch turns the plugin off.
import { done, ok } from "@lightstart/test/assert.ts";
import { AgentRig, toolTextOf } from "./support/agent-rig.ts";

const FIXTURE = [
  '{"match":"env","text":"Writing.","tools":[{"name":"Write","input":{"file_path":".env","content":"X=1"}}]}',
  '{"match":"result","text":"Wrote."}',
  '{"match":"envlocal","text":"Writing.","tools":[{"name":"Write","input":{"file_path":".env.local","content":"X=1"}}]}',
  '{"match":"result","text":"Wrote."}',
  '{"match":"git","text":"Writing.","tools":[{"name":"Write","input":{"file_path":".git/config","content":"x"}}]}',
  '{"match":"result","text":"Wrote."}',
  '{"match":"modules","text":"Writing.","tools":[{"name":"Write","input":{"file_path":"node_modules/pkg/index.js","content":"x"}}]}',
  '{"match":"result","text":"Wrote."}',
  '{"match":"ordinary","text":"Writing.","tools":[{"name":"Write","input":{"file_path":"notes.txt","content":"x"}}]}',
  '{"match":"result","text":"Wrote."}',
  '{"match":"redirect","text":"Running.","tools":[{"name":"Bash","input":{"command":"echo x > .env"}}]}',
  '{"match":"result","text":"Ran."}',
  '{"match":"remove","text":"Running.","tools":[{"name":"Bash","input":{"command":"rm -rf .git"}}]}',
  '{"match":"result","text":"Ran."}',
  '{"match":"secret","text":"Writing.","tools":[{"name":"Write","input":{"file_path":"secret/key.txt","content":"x"}}]}',
  '{"match":"result","text":"Wrote."}',
].join("\n");

const blockedBy = (turn: string[], rule: string): boolean => {
  const text = toolTextOf(turn);
  return text.includes("blocked by") && text.includes(rule);
};

const main = async (): Promise<void> => {
  {
    const rig = new AgentRig(FIXTURE, ["protected-paths"]);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "env");
    ok("a write to .env is blocked by the .env rule", blockedBy(rig.taken(), '.env"'));
    await rig.prompt(sid, "envlocal");
    ok("a write to .env.local is blocked by the .env.* rule", blockedBy(rig.taken(), ".env.*"));
    await rig.prompt(sid, "git");
    ok("a write under .git/ is blocked by its rule", blockedBy(rig.taken(), ".git/"));
    await rig.prompt(sid, "modules");
    ok("a write under node_modules/ is blocked by its rule", blockedBy(rig.taken(), "node_modules/"));
    await rig.prompt(sid, "ordinary");
    ok("a write to an ordinary file is allowed", !toolTextOf(rig.taken()).includes("blocked by"));
    await rig.prompt(sid, "redirect");
    ok("a Bash redirect into .env is blocked", blockedBy(rig.taken(), '.env"'));
    await rig.prompt(sid, "remove");
    ok("a Bash rm of .git is blocked", blockedBy(rig.taken(), ".git/"));
    rig.close();
  }

  // The settings' paths replace the defaults.
  {
    const rig = new AgentRig(FIXTURE, ["protected-paths"]);
    rig.configure({ plugins: { "protected-paths": { paths: ["secret/**"] } } });
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "env");
    ok("a default path passes when the settings replace them", !toolTextOf(rig.taken()).includes("blocked by"));
    await rig.prompt(sid, "secret");
    ok("a settings path is blocked, its rule named", blockedBy(rig.taken(), "secret/**"));
    rig.close();
  }

  // config.json switches the plugin off.
  {
    const rig = new AgentRig(FIXTURE, ["protected-paths"]);
    rig.configure({ plugins: { "protected-paths": false } });
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "env");
    ok("a plugin switched off lets a write to .env through", !toolTextOf(rig.taken()).includes("blocked by"));
    rig.close();
  }

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
