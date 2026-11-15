// ffi: @light/plugins/native/ffi.json
// The dirty-repo-guard plugin's agent part over the harness: a clean repository forks, a dirty one
// asks and forks on yes, is refused on no, a side question's fork does not ask, and a folder that
// is not a repository forks.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { done, eq, ok } from "@light/test/assert.ts";
import { AgentRig, until } from "./support/agent-rig.ts";

const FIXTURE = '{"match":"hello","text":"Hi."}';

const git = (repo: string, args: string[]): void => {
  spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
};

const commit = (repo: string): void => {
  git(repo, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first"]);
};

/** The answer line for `id`. */
const answerOf = async (rig: AgentRig, id: string): Promise<string> => {
  await until(() => rig.out.some((line) => line.includes('"id":' + id + ",")));
  return rig.out.find((line) => line.includes('"id":' + id + ",")) ?? "";
};

const main = async (): Promise<void> => {
  const rig = new AgentRig(FIXTURE, ["dirty-repo-guard"]);
  const repo = join(rig.folder, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, ["add", "."]);
  commit(repo);
  const plain = join(rig.folder, "plain");
  mkdirSync(plain);

  rig.initialize(true);
  const sid = rig.session({ cwd: repo, mcpServers: [] });
  rig.taken();

  // A clean repository forks without asking.
  const clean = rig.send("session/fork", { sessionId: sid, cwd: repo, mcpServers: [] });
  const cleanAnswer = await answerOf(rig, clean);
  ok("a clean repository forks", cleanAnswer.includes('"sessionId"') && !cleanAnswer.includes('"error"'));
  rig.taken();

  // A dirty one asks; yes forks.
  writeFileSync(join(repo, "a.txt"), "changed\n");
  const yesFork = rig.send("session/fork", { sessionId: sid, cwd: repo, mcpServers: [] });
  const yesDialog = await rig.uiRequest("confirm");
  eq("the question is the plugin's", String(yesDialog.params["title"]), "Fork with uncommitted changes?");
  ok("and shows the status", String(yesDialog.params["message"]).includes("M a.txt"));
  rig.respond(yesDialog.id, { confirmed: true });
  const yesAnswer = await answerOf(rig, yesFork);
  ok("a dirty repository forks on yes", yesAnswer.includes('"sessionId"') && !yesAnswer.includes('"error"'));
  rig.taken();

  // No refuses the fork with the plugin's name.
  const noFork = rig.send("session/fork", { sessionId: sid, cwd: repo, mcpServers: [] });
  const noDialog = await rig.uiRequest("confirm");
  rig.respond(noDialog.id, { confirmed: false });
  const noAnswer = await answerOf(rig, noFork);
  ok("a dirty repository is refused on no", noAnswer.includes('"error"') && noAnswer.includes("refused by plugin dirty-repo-guard"));
  rig.taken();

  // A side question's fork changes no file: it forks without asking, the tree still dirty.
  const sideFork = rig.send("session/fork", { sessionId: sid, cwd: repo, mcpServers: [], _meta: { widecode: { side: true } } });
  const sideAnswer = await answerOf(rig, sideFork);
  ok("a side question's fork forks without asking", sideAnswer.includes('"sessionId"') && !sideAnswer.includes('"error"') && !rig.out.some((line) => line.includes('"_widecode/ui"')));
  rig.taken();

  // A folder that is not a repository forks.
  const plainSid = rig.session({ cwd: plain, mcpServers: [] });
  rig.taken();
  const plainFork = rig.send("session/fork", { sessionId: plainSid, cwd: plain, mcpServers: [] });
  const plainAnswer = await answerOf(rig, plainFork);
  ok("a folder that is not a repository forks", plainAnswer.includes('"sessionId"') && !plainAnswer.includes('"error"'));

  rig.close();
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
