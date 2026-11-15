// ffi: @lightstart/plugins/native/ffi.json
// The inline-bash plugin's agent part over the harness: a prompt's `!{command}` reaches the model
// as the command's output, a failing command as its exit code and stderr, two commands both
// expanded, and a prompt without `!{` left as it was.
import { done, eq } from "@lightstart/test/assert.ts";
import { AgentRig } from "./support/agent-rig.ts";

const FIXTURE = [
  '{"match":"run","text":"Ran."}',
  '{"match":"fail","text":"Ran."}',
  '{"match":"two","text":"Ran."}',
  '{"match":"plain","text":"Ran."}',
].join("\n");

/** The text of the last user message in request `n`. */
const promptIn = (rig: AgentRig, n: number): string => {
  const messages = rig.asks()[n].messages;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i].text();
  return "";
};

const main = async (): Promise<void> => {
  const rig = new AgentRig(FIXTURE, ["inline-bash"]);
  rig.initialize(true);
  const sid = rig.session({ cwd: rig.folder, mcpServers: [] });
  rig.taken();

  await rig.prompt(sid, "run !{echo hi}");
  eq("a command's output replaces it, without the last newline", promptIn(rig, 0), "run hi");

  await rig.prompt(sid, "fail !{echo oops >&2; exit 3}");
  eq("a failing command becomes its exit code and stderr", promptIn(rig, 1), "fail [exit 3: oops]");

  await rig.prompt(sid, "two !{printf a} !{printf b}");
  eq("two commands are both expanded", promptIn(rig, 2), "two a b");

  await rig.prompt(sid, "plain words");
  eq("a prompt without !{ is untouched", promptIn(rig, 3), "plain words");

  rig.close();
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
