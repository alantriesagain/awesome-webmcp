// ffi: @lightstart/plugins/native/ffi.json
// The claude-rules plugin's agent part over the harness: the Markdown files of the session
// folder's .claude/rules/ reach the model in the system prompt, each under a heading with its
// file name, and a folder without that directory leaves the system prompt alone.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { done, ok } from "@lightstart/test/assert.ts";
import { AgentRig } from "./support/agent-rig.ts";

const FIXTURE = '{"match":"rules","text":"Read."}';

/** The system text request `n` sent. */
const systemIn = (rig: AgentRig, n: number): string => rig.asks()[n].system.join("\n");

const main = async (): Promise<void> => {
  {
    const rig = new AgentRig(FIXTURE, ["claude-rules"]);
    const dir = join(rig.folder, ".claude", "rules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), "Always write tests.\n");
    writeFileSync(join(dir, "b.md"), "Use tabs.\n");
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "rules");
    const system = systemIn(rig, 0);
    ok("the rules have the project section", system.includes("# Project rules"));
    ok("a rule file is under a heading with its name", system.includes("## a.md") && system.includes("Always write tests."));
    ok("the other rule file too", system.includes("## b.md") && system.includes("Use tabs."));
    rig.close();
  }

  {
    const rig = new AgentRig(FIXTURE, ["claude-rules"]);
    rig.initialize(true);
    const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
    rig.taken();
    await rig.prompt(sid, "rules");
    ok("a folder without rules leaves the system prompt alone", !systemIn(rig, 0).includes("# Project rules"));
    rig.close();
  }

  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
