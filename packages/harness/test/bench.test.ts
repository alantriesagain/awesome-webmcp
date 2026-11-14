// node-only
// The benchmark over its own tasks and the harness on its fake model: each task's check fails on
// the repository as given and passes with its solution; a run through ACP (the model and effort
// chosen through the session's options) whose model writes the right answer passes, one that
// writes a wrong one fails with the check's words, each measured (the calls by tool, the time to
// the first token, the stop reason) and its session forgotten after; the records read back; the
// table.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportText } from "../bench/report.ts";
import { ModelPrice, PriceTable, RunResult, RunSpec, loadTasks, opencodeUsage, pricesFromConfig, runTask } from "../bench/runner.ts";
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

  const exported = opencodeUsage(readFileSync(join(process.cwd(), "test", "fixtures", "opencode-export.json"), "utf8"));
  eq(
    "opencode's export: its assistant messages, the cache counted in the input",
    exported === null ? "none" : [exported.requests, exported.inputTokens, exported.cacheReadTokens, exported.outputTokens, exported.firstInputTokens, exported.peakContext].join(","),
    "6,68450,57732,323,10942,11830",
  );
  ok("the export's own cost", exported !== null && exported.costUsd.toFixed(6) === "0.003949");
  eq("an export with no assistant message gives nothing", String(opencodeUsage('{"messages":[]}')), "null");

  const home = mkdtempSync(join(tmpdir(), "bench-home-"));
  const registryPrices = pricesFromConfig(join(home, "missing-config.json"));
  const zen = registryPrices.of("opencode/deepseek-v4.1-flash");
  eq("the registry's prices, built in rather than config.json's", zen === null ? "none" : [zen.input, zen.output, zen.cacheRead].join(","), "0.3,1.2,0.006");
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
  spec.userStore = true;
  eq("a price: the cache's reads at their own", prices.cost("fake/fake", 1000000, 400000, 500000).toFixed(2) + " " + String(prices.cost("other/model", 1, 0, 1)), "1.64 -1");
  const task = tasks.filter((t) => t.name === "answer-from-code")[0];
  const good = await runTask(task, spec);
  eq("a run that answers right passes", String(good.passed) + " " + good.stopReason + " " + good.error + "|" + good.tools.join(",") + " " + String(good.calls) + " " + String(good.failedCalls) + " " + good.checkOutput, "true end_turn |Write=1 1 0 ok");
  ok("measured: the first token, the time, the tokens, the reply", good.firstTokenMs >= 0 && good.ms >= good.firstTokenMs && good.outputTokens > 0 && good.reply === "Writing it.Done.");
  ok("diagnosed: the first request, the requests, no compaction, the peak context, the computed cost", good.firstInputTokens > 0 && good.requests === 2 && good.compacted === 0 && good.peakContext >= good.firstInputTokens && good.computedCostUsd > 0);
  ok("its folder removed, its session forgotten", !existsSync(good.folder) && readdirSync(join(home, "harness", "sessions")).every((d) => readdirSync(join(home, "harness", "sessions", d)).length === 0));
  const pi = new RunSpec();
  pi.agent = "pi";
  pi.command = ["node", join(process.cwd(), "test", "fake-pi.mjs")];
  pi.model = "opencode/deepseek-v4.1-flash";
  pi.prices = registryPrices;
  const piRun = await runTask(task, pi);
  eq("pi over its RPC: the tool call, the stop, the check", String(piRun.passed) + " " + piRun.stopReason + " " + piRun.error + "|" + piRun.tools.join(",") + " " + String(piRun.calls) + " " + String(piRun.failedCalls) + " " + piRun.checkOutput, "true stop |write=1 1 0 ok");
  ok(
    "pi measured: the first token, the requests, the input with cache, the first input, the peak context, no compaction, its cost, the computed cost",
    piRun.firstTokenMs >= 0 && piRun.requests === 2 && piRun.inputTokens === 200 && piRun.cacheReadTokens === 70 && piRun.outputTokens === 15 && piRun.firstInputTokens === 50 && piRun.peakContext === 150 && piRun.compacted === 0 && Math.abs(piRun.costUsd - 0.0015) < 1e-9 && piRun.computedCostUsd > 0,
  );
  eq("pi's reply", piRun.reply, "done");
  spec.command = ["node", daemon, "--harness", "--harness-fake", wrong, "--harness-home", home];
  const bad = await runTask(task, spec);
  eq("one that answers wrong fails, with the check's words", String(bad.passed) + " " + bad.checkOutput, 'false answer.txt says "8080"');
  const missing = new RunSpec();
  missing.agent = "harness";
  missing.command = spec.command;
  missing.model = "nowhere/model";
  const refused = await runTask(task, missing);
  ok("a model the agent does not offer: said, with those it does", !refused.passed && refused.error.startsWith("no model nowhere/model here; the agent offers fake/fake, anthropic/"));
  // A clean run: a fresh store of its own, its auth.json a link to the user's, its session file there
  // rather than in the store the test otherwise names.
  const cleanSpec = new RunSpec();
  cleanSpec.agent = "harness";
  cleanSpec.command = ["node", daemon, "--harness", "--harness-fake", fixture];
  cleanSpec.model = "fake/fake";
  cleanSpec.effort = "low";
  cleanSpec.keep = true;
  const clean = await runTask(task, cleanSpec);
  const cleanSessions = join(clean.store, "harness", "sessions");
  const userStore = (process.env["WIDECODE_HOME"] ?? "").length > 0 ? (process.env["WIDECODE_HOME"] ?? "") : join(process.env["HOME"] ?? "", ".widecode");
  ok(
    "a clean run: its own store, the key linked not copied, its session there",
    clean.store.length > 0 &&
      clean.store !== home &&
      lstatSync(join(clean.store, "auth.json")).isSymbolicLink() &&
      readlinkSync(join(clean.store, "auth.json")) === join(userStore, "auth.json") &&
      existsSync(cleanSessions) &&
      readdirSync(cleanSessions).some((d) => readdirSync(join(cleanSessions, d)).length > 0),
  );
  ok("the clean run did not use the test's store", !existsSync(join(home, "harness", "sessions")) || readdirSync(join(home, "harness", "sessions")).every((d) => readdirSync(join(home, "harness", "sessions", d)).length === 0));
  rmSync(clean.folder, { recursive: true, force: true });
  rmSync(clean.store, { recursive: true, force: true });
  // A command that exits at once never answers initialize: a setup failure, not a task failure.
  const dead = new RunSpec();
  dead.agent = "harness";
  dead.command = ["node", "-e", "process.exit(3)"];
  const setup = await runTask(task, dead);
  ok("a command that exits at once is a setup failure", setup.setupFailed && !setup.passed && setup.error.startsWith("initialize: "));
  const setupBack = RunResult.parse(setup.line());
  ok("a setup failure recorded and read back", setupBack !== null && setupBack.setupFailed && !setupBack.passed);

  const back = RunResult.parse(good.line());
  eq("a record read back", back === null ? "none" : back.task + " " + String(back.passed) + " " + back.tools.join(",") + " " + back.reply, "answer-from-code true Write=1 Writing it.Done.");
  ok("the record keeps the diagnosis", back !== null && back.firstInputTokens === good.firstInputTokens && back.requests === good.requests && back.compacted === good.compacted && back.peakContext === good.peakContext && back.cacheReadTokens === good.cacheReadTokens && back.computedCostUsd === good.computedCostUsd);
  const table = reportText([good, bad, refused]);
  ok(
    "the table: a row per agent and model, the tasks passed, the setup failure apart from the failures",
    table.includes("| harness fake/fake low | 1/2 | 0 |") &&
      table.includes("| harness nowhere/model | 0/0 | 1 |") &&
      table.includes("| answer-from-code | 1/2 |") &&
      table.includes("- answer-from-code, harness fake/fake: answer.txt says \"8080\"") &&
      table.includes("- answer-from-code, harness nowhere/model: setup failure: no model nowhere/model here;"),
  );
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
  const setupFailure = record("opencode", "t3", false);
  setupFailure.setupFailed = true;
  setupFailure.error = "initialize: timed out";
  const withSetup = reportText([record("harness", "t1", true), setupFailure]);
  ok(
    "setup failures: counted apart, out of passed/runs and every mean, named in the failures",
    withSetup.includes("| harness fake/fake | 1/1 | 0 |") &&
      withSetup.includes("| opencode fake/fake | 0/0 | 1 |") &&
      withSetup.includes("- t3, opencode fake/fake: setup failure: initialize: timed out") &&
      !withSetup.includes("- t3, opencode fake/fake: initialize: timed out"),
  );
  rmSync(home, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
