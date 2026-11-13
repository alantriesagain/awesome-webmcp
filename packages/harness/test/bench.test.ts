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
import { ModelPrice, PriceTable, RunResult, RunSpec, loadTasks, runTask } from "../bench/runner.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const main = async (): Promise<void> => {
  const tasks = loadTasks(join(process.cwd(), "bench", "tasks"), []);
  eq("the tasks", tasks.map((t) => t.name).join(","), "add-flag,answer-from-code,csv-quotes,edit-json,fix-bug,implement-slug,keep-tests-green,limit-concurrency,long-file-edit,misleading-failure,noisy-output,rename-symbol,run-to-see,signature-change,trace-config,whitespace-exact");
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
      // The second request's context larger than the first's, as a real one grows.
      '{"match":"result","text":"Done.","input":40}',
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
  const prices = new PriceTable();
  prices.add("fake/fake", new ModelPrice(1, 2, 0.1));
  spec.prices = prices;
  eq("a price: the cache's reads at their own", prices.cost("fake/fake", 1000000, 400000, 500000).toFixed(2) + " " + String(prices.cost("other/model", 1, 0, 1)), "1.64 -1");
  const task = tasks.filter((t) => t.name === "answer-from-code")[0];
  const good = await runTask(task, spec);
  eq("a run that answers right passes", String(good.passed) + " " + good.stopReason + " " + good.error + "|" + good.tools.join(",") + " " + String(good.calls) + " " + String(good.failedCalls) + " " + good.checkOutput, "true end_turn |Write=1 1 0 ok");
  ok("measured: the first token, the time, the tokens, the reply", good.firstTokenMs >= 0 && good.ms >= good.firstTokenMs && good.outputTokens > 0 && good.reply === "Writing it.Done.");
  ok("diagnosed: the first request, the requests, no compaction, the peak context, the computed cost", good.firstInputTokens > 0 && good.requests === 2 && good.compacted === 0 && good.peakContext >= good.firstInputTokens && good.computedCostUsd > 0);
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
  ok("the record keeps the diagnosis", back !== null && back.firstInputTokens === good.firstInputTokens && back.requests === good.requests && back.compacted === good.compacted && back.peakContext === good.peakContext && back.cacheReadTokens === good.cacheReadTokens && back.computedCostUsd === good.computedCostUsd);
  const table = reportText([good, bad, refused]);
  ok("the table: a row per agent and model, the tasks passed, the failures", table.includes("| harness fake/fake low | 1/2 |") && table.includes("| answer-from-code | 1/2 | 0/1 |") && table.includes("- answer-from-code, harness fake/fake: answer.txt says \"8080\""));
  ok("the table shows the diagnosis columns", table.includes("| first input | requests | compacted | peak context |"));
  // Two agents on one model: the paired table with the harness as the baseline and each other's difference.
  const record = (agent: string, task: string, passed: boolean): RunResult => {
    const r = new RunResult();
    r.agent = agent;
    r.task = task;
    r.model = "fake/fake";
    r.passed = passed;
    r.ms = 1000;
    r.firstTokenMs = 100;
    r.inputTokens = 10;
    r.outputTokens = 2;
    r.firstInputTokens = 100;
    r.requests = 2;
    r.compacted = 0;
    r.peakContext = 200;
    r.computedCostUsd = 0.001;
    return r;
  };
  const paired = reportText([record("opencode", "t1", true), record("harness", "t1", false), record("opencode", "t2", true), record("harness", "t2", true)]);
  ok("the paired table: each agent, its difference from the harness, the total", paired.includes("### fake/fake (baseline: harness)") && paired.includes("| t1 | 0/1 | 1/1 | +100.0% |") && paired.includes("| t2 | 1/1 | 1/1 | 0.0% |") && paired.includes("| total | 1/2 | 2/2 | +50.0% |"));
  rmSync(home, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
