// ffi: @lightstart/plugins/native/ffi.json
// The git-checkpoint plugin's agent part over the harness: each turn in a repository keeps a
// checkpoint, /checkpoints lists them, /checkpoint restore brings back a confirmed one's tracked
// files while leaving untracked files alone, a refusal changes nothing, no ref is written, a
// pruned commit is reported, /checkpoint clear forgets the list, a session loaded again reads the
// list from its branch, and a folder without git records nothing.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { AgentRig, until } from "./support/agent-rig.ts";

const FIXTURE = ['{"match":"first","text":"One."}', '{"match":"second","text":"Two."}'].join("\n");

const git = (repo: string, args: string[]): string => {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return ((result.stdout ?? "") + (result.stderr ?? "")).trim();
};

/** The answer line for `id`. */
const answerOf = async (rig: AgentRig, id: string): Promise<string> => {
  await until(() => rig.out.some((line) => line.includes('"id":' + id + ",")));
  return rig.out.find((line) => line.includes('"id":' + id + ",")) ?? "";
};

const main = async (): Promise<void> => {
  const rig = new AgentRig(FIXTURE, ["git-checkpoint"]);
  const repo = join(rig.folder, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "first"]);
  writeFileSync(join(repo, "a.txt"), "first\n");

  rig.initialize(true);
  const sid = rig.session({ cwd: repo, mcpServers: [] });
  rig.taken();

  // Two turns, the file changed between them: two checkpoints.
  await rig.prompt(sid, "first");
  writeFileSync(join(repo, "a.txt"), "second\n");
  await rig.prompt(sid, "second");

  await rig.prompt(sid, "/checkpoints");
  const listed = String((await rig.uiNotification("notify"))["message"]);
  ok("both checkpoints are listed with their numbers", /^1\s/m.test(listed) && /^2\s/m.test(listed));
  ok("with their times and short commits", listed.includes(" ago  ") && /[0-9a-f]{7}/.test(listed));

  // A session loaded again in a fresh agent reads the checkpoints from its branch.
  rig.reopen(["git-checkpoint"], FIXTURE);
  rig.initialize(true);
  const loadId = rig.send("session/load", { sessionId: sid, cwd: repo, mcpServers: [] });
  await answerOf(rig, loadId);
  rig.taken();
  await rig.prompt(sid, "/checkpoints");
  const reloaded = String((await rig.uiNotification("notify"))["message"]);
  ok("a loaded session still lists them", /^1\s/m.test(reloaded) && /^2\s/m.test(reloaded));

  // Restore the first one after a confirm: its tracked contents come back, untracked files stay.
  writeFileSync(join(repo, "a.txt"), "third\n");
  writeFileSync(join(repo, "keep.txt"), "keep\n");
  const restoring = rig.prompt(sid, "/checkpoint restore 1");
  const dialog = await rig.uiRequest("confirm");
  eq("the question names the checkpoint", String(dialog.params["title"]), "Restore checkpoint 1?");
  rig.respond(dialog.id, { confirmed: true });
  await restoring;
  eq("the tracked file is back at the first checkpoint", readFileSync(join(repo, "a.txt"), "utf8"), "first\n");
  ok("the untracked file is left alone", existsSync(join(repo, "keep.txt")) && readFileSync(join(repo, "keep.txt"), "utf8") === "keep\n");
  eq("and the restore is reported", String((await rig.uiNotification("notify"))["message"]), "Restored checkpoint 1.");

  // A refusal changes nothing.
  writeFileSync(join(repo, "a.txt"), "fourth\n");
  const refusing = rig.prompt(sid, "/checkpoint restore 2");
  const noDialog = await rig.uiRequest("confirm");
  rig.respond(noDialog.id, { confirmed: false });
  await refusing;
  eq("a refused restore leaves the file as it was", readFileSync(join(repo, "a.txt"), "utf8"), "fourth\n");
  eq("and says so", String((await rig.uiNotification("notify"))["message"]), "Restore cancelled.");

  // The repository has no new refs: the checkpoints are commits nothing points at.
  eq("no ref is written", git(repo, ["for-each-ref", "--format=%(refname)", "refs/lightcode/"]) + git(repo, ["stash", "list"]), "");

  // A checkpoint whose commit git pruned is reported, the files untouched.
  git(repo, ["reflog", "expire", "--expire-unreachable=now", "--all"]);
  git(repo, ["gc", "--prune=now", "-q"]);
  const pruning = rig.prompt(sid, "/checkpoint restore 2");
  const pruneDialog = await rig.uiRequest("confirm");
  rig.respond(pruneDialog.id, { confirmed: true });
  await pruning;
  eq("a pruned checkpoint is reported", String((await rig.uiNotification("notify"))["message"]), "Checkpoint 2 is gone: git pruned its commit.");
  eq("and the file is left as it was", readFileSync(join(repo, "a.txt"), "utf8"), "fourth\n");

  // Clear forgets the session's list.
  await rig.prompt(sid, "/checkpoint clear");
  eq("the clear is reported", String((await rig.uiNotification("notify"))["message"]), "Forgot 2 checkpoints.");
  await rig.prompt(sid, "/checkpoints");
  eq("and the list is empty", String((await rig.uiNotification("notify"))["message"]), "No checkpoints.");

  // A folder without git records nothing.
  const plain = join(rig.folder, "plain");
  mkdirSync(plain);
  const plainSid = rig.session({ cwd: plain, mcpServers: [] });
  rig.taken();
  await rig.prompt(plainSid, "first");
  await rig.prompt(plainSid, "/checkpoints");
  eq("a folder without git has no checkpoints", String((await rig.uiNotification("notify"))["message"]), "No checkpoints.");

  rig.close();
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
