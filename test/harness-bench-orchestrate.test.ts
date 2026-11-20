// node-only
// The orchestration benchmark's parts the test can reach without a model: its tasks load and their
// repositories assemble (each part in a subfolder the prompt names); each part's check fails on the
// assembled repository and passes with the part's solution; the measures read a fake harness
// session, a fake Claude transcript and a fake opencode export and session list; the done signal
// reads a sample log; a record round-trips; the report draws its tables. The pty run itself needs
// dist/widecode and a real orchestrator, so it is not run here.
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listOf, recordOf, str } from "@lightstart/lib/json.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { OrchestrateRecord } from "../src/harness/bench/orchestrate/record.ts";
import { reportText } from "../src/harness/bench/orchestrate/report.ts";
import { SubagentUse, pendingBackground, readClaudeTranscript, readHarnessSession, readLogSignal, subagentFromExport, subagentSessions } from "../src/harness/bench/orchestrate/measures.ts";
import { PartVerdict, assembleRepo, checkParts, copySolutions, loadTasks } from "../src/harness/bench/orchestrate/tasks.ts";
import { SetupSpec, createSetup } from "../src/harness/bench/orchestrate/setup.ts";

const main = (): void => {
  const cwd = process.cwd();
  const tasksRoot = join(cwd, "src", "harness", "bench", "orchestrate", "tasks");
  const partRoot = join(cwd, "src", "harness", "bench", "tasks");
  const tasks = loadTasks(tasksRoot, partRoot, []);
  eq("the five tasks", tasks.map((t) => t.name).join(","), "cross-folder,easy-two,medium-three,mixed-four,web-and-code");
  eq("the parts", tasks.map((t) => t.name + ":" + t.parts.join("+")).join(" "), "cross-folder:answer-from-code+edit-json easy-two:add-flag+edit-json medium-three:fix-bug+implement-slug+limit-concurrency mixed-four:csv-quotes+rename-symbol+keep-tests-green+trace-config web-and-code:search-release-date+edit-json");
  for (const t of tasks) {
    ok("the prompt names each part of " + t.name, t.parts.every((p) => t.prompt.includes("`" + p + "`")));
    ok("the prompt says the parts are independent: " + t.name, t.prompt.includes("independent"));
  }
  eq("only the web task has a part that searches", tasks.filter((t) => t.web(partRoot)).map((t) => t.name).join(","), "web-and-code");

  const assembly: string[] = [];
  const verdicts: string[] = [];
  for (const t of tasks) {
    const folder = mkdtempSync(join(tmpdir(), "orchestrate-check-" + t.name + "-"));
    assembleRepo(t, partRoot, folder);
    assembly.push(t.name + ":" + readdirSync(folder).filter((n) => !n.startsWith(".")).sort().join("+"));
    const given = checkParts(t, partRoot, folder);
    copySolutions(t, partRoot, folder);
    const solved = checkParts(t, partRoot, folder);
    verdicts.push(t.name + ":" + given.map((v) => (v.passed ? "passes" : "fails")).join("/") + "|" + solved.map((v) => (v.passed ? "passes" : "fails")).join("/"));
    rmSync(folder, { recursive: true, force: true });
  }
  eq("each part assembled in its own subfolder", assembly.join(" "), "cross-folder:answer-from-code+edit-json easy-two:add-flag+edit-json medium-three:fix-bug+implement-slug+limit-concurrency mixed-four:csv-quotes+keep-tests-green+rename-symbol+trace-config web-and-code:edit-json+search-release-date");
  eq("every check fails as given and passes solved", verdicts.join(" "), "cross-folder:fails/fails|passes/passes easy-two:fails/fails|passes/passes medium-three:fails/fails/fails|passes/passes/passes mixed-four:fails/fails/fails/fails|passes/passes/passes/passes web-and-code:fails/fails|passes/passes");

  const easy = tasks.filter((t) => t.name === "easy-two")[0];
  const setupSpec = new SetupSpec();
  setupSpec.orchestrator = "harness";
  setupSpec.model = "opencode-go/deepseek-v4.1-flash";
  setupSpec.promptText = "the guidance";
  const setup = createSetup(easy, partRoot, setupSpec);
  eq("a run's folder holds each part", readdirSync(setup.folder).filter((n) => !n.startsWith(".")).sort().join("+"), "add-flag+edit-json");
  eq("its guidance is the file it was given", readFileSync(join(setup.folder, ".widecode", "prompt.md"), "utf8"), "the guidance");
  const config = recordOf(JSON.parse(readFileSync(join(setup.store, "config.json"), "utf8")));
  const plugins = config !== null ? recordOf(config["plugins"]) : null;
  const acp = plugins !== null ? recordOf(plugins["acp"]) : null;
  const tasksConfig = acp !== null ? recordOf(acp["tasks"]) : null;
  const targets = tasksConfig !== null ? recordOf(tasksConfig["targets"]) : null;
  const deepseek = targets !== null ? recordOf(targets["deepseek"]) : null;
  eq("its config names the orchestrator, the harness model and the target", [config !== null ? str(config["agent"]) : "", config !== null ? str(recordOf(config["harness"])?.["model"]) : "", deepseek !== null ? str(deepseek["agent"]) + " " + str(deepseek["model"]) : "", tasksConfig !== null && tasksConfig["replaceClaudeSubagents"] === true ? "replaced" : ""].join(","), "harness,opencode-go/deepseek-v4.1-flash,opencode opencode-go/deepseek-v4.1-flash,replaced");
  ok("the folder is trusted", listOf(JSON.parse(readFileSync(join(setup.store, "trusted.json"), "utf8"))).includes(setup.folder));
  ok("a key is linked, never copied", !existsSync(join(setup.store, "auth.json")) || lstatSync(join(setup.store, "auth.json")).isSymbolicLink());
  rmSync(setup.folder, { recursive: true, force: true });
  rmSync(setup.store, { recursive: true, force: true });

  const harness = readHarnessSession(readFileSync(join(cwd, "test", "harness", "fixtures", "orchestrate-harness-session.jsonl"), "utf8"));
  eq("a harness session: its usage entries", [harness.usage.requests, harness.usage.input, harness.usage.output, harness.usage.cacheRead, harness.usage.cacheWrite, harness.usage.costUsd.toFixed(3)].join(","), "2,300,70,40,5,0.003");
  eq("a harness session: its own edits, writes and Task calls", [harness.edits, harness.writes, harness.taskCalls, harness.taskBackground, harness.backgroundIds.join("+")].join(","), "1,1,2,1,call_1");

  const claude = readClaudeTranscript(readFileSync(join(cwd, "test", "harness", "fixtures", "orchestrate-claude-session.jsonl"), "utf8"));
  eq("a Claude transcript: its assistant usage and result cost", [claude.usage.requests, claude.usage.input, claude.usage.output, claude.usage.cacheRead, claude.usage.cacheWrite, claude.usage.costUsd.toFixed(3)].join(","), "2,14,5,6,2,0.010");
  eq("a Claude transcript: its own edits and Task call", [claude.edits, claude.writes, claude.taskCalls, claude.taskBackground, claude.backgroundIds.join("+")].join(","), "1,0,1,1,t1");

  const exportText = readFileSync(join(cwd, "test", "harness", "fixtures", "orchestrate-opencode-export.json"), "utf8");
  const sub = subagentFromExport("ses_1", "opencode", exportText);
  eq("an opencode export: a subagent's requests, tokens and cost", sub === null ? "none" : [sub.requests, sub.input, sub.cacheRead, sub.output, sub.costUsd.toFixed(6)].join(","), "6,68450,57732,323,0.003949");
  const listText = readFileSync(join(cwd, "test", "harness", "fixtures", "orchestrate-opencode-sessions.json"), "utf8");
  eq("opencode's session list: the sessions in the folder since the run", subagentSessions(listText, "/work/repo", 1760000000000).join(",") + " / " + subagentSessions(listText, "/elsewhere", 0).join(","), "ses_1 / ");

  const log = "--- log opened 2026-11-19T10:00:00Z\n      1 turn started\n      2 turn ended after 3 s\n      3 background subagent call_9 finished\n";
  const signal = readLogSignal(log);
  eq("the done signal: turns and a finished subagent", [signal.started, signal.ended, signal.running, signal.idleAfterTurn(), signal.finished.join("+")].join(","), "1,1,false,true,call_9");
  eq("a subagent still out holds the run open", pendingBackground(["call_9", "call_10"], signal).join("+"), "call_10");
  const mid = readLogSignal(log.split("\n")[1] + "\n" + log.split("\n")[3] + "\n");
  ok("a turn open is not done", !mid.idleAfterTurn() && mid.running);

  const record = new OrchestrateRecord();
  record.task = "easy-two";
  record.orchestrator = "harness";
  record.model = "opencode-go/deepseek-v4.1-flash";
  record.repeat = 2;
  record.passed = true;
  record.ms = 120000;
  const p = new PartVerdict();
  p.name = "add-flag";
  p.passed = true;
  p.output = "ok";
  record.parts.push(p);
  record.requests = 3;
  record.inputTokens = 190;
  record.outputTokens = 40;
  record.cacheReadTokens = 90;
  record.costUsd = 0.003;
  record.ownEdits = 1;
  record.ownWrites = 1;
  record.taskCalls = 2;
  record.taskBackground = 1;
  record.taskForeground = 1;
  const use = new SubagentUse();
  use.id = "ses_1";
  use.agent = "opencode";
  use.requests = 6;
  use.input = 68450;
  use.output = 323;
  use.cacheRead = 57732;
  use.costUsd = 0.004;
  record.subagents.push(use);
  record.subagentCostUsd = 0.004;
  record.subagentInputTokens = 126182;
  record.subagentOutputTokens = 323;
  record.totalCostUsd = 0.007;
  record.files.session = "/out/session.jsonl";
  record.files.log = "/out/app.log";
  record.files.screen = "/out/screen.txt";
  const back = OrchestrateRecord.parse(record.line());
  ok("a record round-trips", back !== null);
  if (back !== null) {
    eq(
      "the round-trip's fields",
      [back.task, back.orchestrator, back.model, String(back.repeat), String(back.passed), String(back.parts.length), String(back.parts[0].passed), String(back.requests), String(back.inputTokens), String(back.costUsd), String(back.ownEdits), String(back.taskCalls), String(back.subagents.length), String(back.subagents[0].cacheRead), String(back.subagentCostUsd), String(back.totalCostUsd), back.files.session].join(","),
      "easy-two,harness,opencode-go/deepseek-v4.1-flash,2,true,1,true,3,190,0.003,1,2,1,57732,0.004,0.007,/out/session.jsonl",
    );
  }
  const other = OrchestrateRecord.parse(back !== null ? back.line() : "");
  ok("a record that is not JSON is no record", OrchestrateRecord.parse("not json") === null && other !== null);

  const claudeRecord = new OrchestrateRecord();
  claudeRecord.task = "easy-two";
  claudeRecord.orchestrator = "claude";
  claudeRecord.model = "opus";
  claudeRecord.passed = false;
  claudeRecord.ms = 60000;
  const missed = new PartVerdict();
  missed.name = "edit-json";
  missed.passed = false;
  missed.output = "package.json is wrong";
  claudeRecord.parts.push(missed);
  claudeRecord.costUsd = 0.01;
  claudeRecord.subagentCostUsd = 0.004;
  claudeRecord.totalCostUsd = 0.014;
  claudeRecord.taskCalls = 1;
  claudeRecord.ownEdits = 2;
  const table = reportText([record, claudeRecord]);
  ok("the report has the orchestrator table and both groups", table.includes("| orchestrator and model | passed | parts |") && table.includes("harness opencode-go/deepseek-v4.1-flash") && table.includes("claude opus"));
  ok("the report has the task table and the failure", table.includes("| task |") && table.includes("| easy-two |") && table.includes("Failed runs:") && table.includes("edit-json: package.json is wrong"));
  done();
};

main();
