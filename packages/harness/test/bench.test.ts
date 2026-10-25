// node-only
// The benchmark over its own tasks and the harness on its fake model: each task's check fails on
// the repository as given and passes with its solution; a run through ACP (the model and effort
// chosen through the session's options) whose model writes the right answer passes, one that
// writes a wrong one fails with the check's words, each measured (the calls by tool, the time to
// the first token, the stop reason) and its session forgotten after; the records read back; the
// table.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportText } from "../bench/report.ts";
import { RunResult, RunSpec, loadTasks, runTask } from "../bench/runner.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const main = async (): Promise<void> => {
  const tasks = loadTasks(join(process.cwd(), "bench", "tasks"), []);
  eq("the tasks", tasks.map((t) => t.name).join(","), "add-flag,answer-from-code,csv-quotes,edit-json,fix-bug,implement-slug,limit-concurrency,rename-symbol");
  const verdicts: string[] = [];
  for (const t of tasks) {
    const dir = mkdtempSync(join(tmpdir(), "bench-check-"));
    cpSync(join(t.dir, "repo"), dir, { recursive: true });
    const given = spawnSync("node", [join(t.dir, "check.mjs")], { cwd: dir }).status === 0;
    cpSync(join(t.dir, "solution"), dir, { recursive: true });
    const solved = spawnSync("node", [join(t.dir, "check.mjs")], { cwd: dir }).status === 0;
    verdicts.push(t.name + ":" + (given ? "passes" : "fails") + "/" + (solved ? "passes" : "fails"));
    rmSync(dir, { recursive: true, force: true });
  }
  eq("each check fails as given and passes solved", verdicts.join(" "), tasks.map((t) => t.name + ":fails/passes").join(" "));

  const home = mkdtempSync(join(tmpdir(), "bench-home-"));
  const fixture = join(home, "model.jsonl");
  writeFileSync(
    fixture,
    [
      '{"match":"Read","text":"Writing it.","thinking":"The default is 8080 plus 363.","tools":[{"name":"Write","input":{"file_path":"answer.txt","content":"8443\\n"}}]}',
      '{"match":"result","text":"Done."}',
    ].join("\n") + "\n",
  );
  // Each run starts the daemon again, its fake model from the fixture's start: the wrong answer is a fixture of its own.
  const wrong = join(home, "wrong.jsonl");
  writeFileSync(wrong, '{"match":"Read","text":"Writing it.","tools":[{"name":"Write","input":{"file_path":"answer.txt","content":"8080\\n"}}]}\n{"match":"result","text":"Done."}\n');
  const daemon = join(process.cwd(), "main.ts");
  const spec = new RunSpec();
  spec.agent = "harness";
  spec.command = ["node", daemon, "--harness", "--harness-fake", fixture, "--harness-home", home];
  spec.forget = ["node", daemon, "--harness-forget", "{session}", "--harness-home", home];
  spec.model = "fake/fake";
  spec.effort = "low";
  const task = tasks.filter((t) => t.name === "answer-from-code")[0];
  const good = await runTask(task, spec);
  eq("a run that answers right passes", String(good.passed) + " " + good.stopReason + " " + good.error + "|" + good.tools.join(",") + " " + String(good.calls) + " " + String(good.failedCalls) + " " + good.checkOutput, "true end_turn |Write=1 1 0 ok");
  ok("measured: the first token, the time, the tokens, the reply", good.firstTokenMs >= 0 && good.ms >= good.firstTokenMs && good.outputTokens > 0 && good.reply === "Writing it.Done.");
  ok("its folder removed, its session forgotten", !existsSync(good.folder) && readdirSync(join(home, "harness", "sessions")).every((d) => readdirSync(join(home, "harness", "sessions", d)).length === 0));
  spec.command = ["node", daemon, "--harness", "--harness-fake", wrong, "--harness-home", home];
  const bad = await runTask(task, spec);
  eq("one that answers wrong fails, with the check's words", String(bad.passed) + " " + bad.checkOutput, 'false answer.txt says "8080"');
  const missing = new RunSpec();
  missing.agent = "harness";
  missing.command = spec.command;
  missing.model = "nowhere/model";
  const refused = await runTask(task, missing);
  ok("a model the agent does not offer: said, with those it does", !refused.passed && refused.error.startsWith("no model nowhere/model here; the agent offers fake/fake, anthropic/"));

  const back = RunResult.parse(good.line());
  eq("a record read back", back === null ? "none" : back.task + " " + String(back.passed) + " " + back.tools.join(",") + " " + back.reply, "answer-from-code true Write=1 Writing it.Done.");
  const table = reportText([good, bad, refused]);
  ok("the table: a row per agent and model, the tasks passed, the failures", table.includes("| harness fake/fake low | 1/2 |") && table.includes("| answer-from-code | 1/2 | 0/1 |") && table.includes("- answer-from-code, harness fake/fake: answer.txt says \"8080\""));
  rmSync(home, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
