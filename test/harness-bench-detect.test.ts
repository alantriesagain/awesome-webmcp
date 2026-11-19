// node-only
// The benchmark's detectors on hand-written transcripts: each rule fires on its pattern and not
// on a reread after an edit, a read at another offset, tests after an edit, a registry command or
// curl on a task without web; a setup failure is left out, an unparsable line skipped, and the
// report's table and examples read.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Detector, detectors, flagsReport, readTranscript } from "../src/harness/bench/detect.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

class Opts {
  command = "";
  input = "";
  failed = false;
  result = "";
  tool = "";
}

const runLine = (task: string, agent: string, web: boolean, setupFailed = false): string =>
  JSON.stringify({ kind: "run", task, agent, model: "m", web, passed: true, setupFailed });

const callLine = (n: number, as: string, path: string, o: Opts = new Opts()): string =>
  JSON.stringify({
    kind: "call",
    n,
    tool: o.tool.length > 0 ? o.tool : as,
    as,
    path,
    command: o.command,
    input: o.input,
    failed: o.failed,
    resultChars: o.result.length,
    result: o.result,
    atMs: n,
  });

const textLine = (atMs: number, text: string): string => JSON.stringify({ kind: "text", atMs, text });

const detector = (id: string): Detector => {
  const found = detectors.filter((d) => d.id === id);
  if (found.length !== 1) throw new Error("no detector " + id);
  return found[0];
};

const ids = (path: string, id: string): string => detector(id).hitsOf(readTranscript(path)).map((h) => String(h.call)).join(",");

const main = (): void => {
  const dir = mkdtempSync(join(tmpdir(), "bench-detect-"));
  const write = (name: string, lines: string[]): string => {
    const path = join(dir, name);
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
  };

  const refused = write("refused.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "edit", "a.txt", Object.assign(new Opts(), { failed: true, result: "File has not been read" })),
    callLine(2, "read", "a.txt"),
    callLine(3, "write", "a.txt"),
  ]);
  eq("refused-then-read fires on the read after the refusal", ids(refused, "refused-then-read"), "2");
  eq("a refusal with no edit after the read does not fire", ids(refused, "read-after-edit"), "");
  const refusedOpen = write("refused-open.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "edit", "a.txt", Object.assign(new Opts(), { failed: true })),
    callLine(2, "read", "a.txt"),
  ]);
  eq("refused-then-read needs the edit after the read", ids(refusedOpen, "refused-then-read"), "");

  const reread = write("reread.jsonl", [runLine("t", "harness", false), callLine(1, "read", "a.txt"), callLine(2, "read", "a.txt")]);
  eq("reread fires on a second read", ids(reread, "reread"), "2");
  const offset = write("offset.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "read", "a.txt", Object.assign(new Opts(), { input: '{"file_path":"a.txt","offset":0,"limit":10}' })),
    callLine(2, "read", "a.txt", Object.assign(new Opts(), { input: '{"file_path":"a.txt","offset":10,"limit":10}' })),
  ]);
  eq("a read at another offset is no reread", ids(offset, "reread"), "");

  const afterEdit = write("after-edit.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "read", "a.txt"),
    callLine(2, "edit", "a.txt"),
    callLine(3, "read", "a.txt"),
  ]);
  eq("read-after-edit fires on the read", ids(afterEdit, "read-after-edit"), "3");
  eq("a read after an edit is no reread", ids(afterEdit, "reread"), "");

  const failed = write("failed.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "bash", "", Object.assign(new Opts(), { command: "make", failed: true, result: "make: boom" })),
    callLine(2, "read", "a.txt"),
  ]);
  eq("failed-call fires on the failed call", ids(failed, "failed-call"), "1");
  const failedHits = detector("failed-call").hitsOf(readTranscript(failed));
  ok("failed-call names the tool and the start of the result", failedHits.length === 1 && failedHits[0].reason === "bash: make: boom");

  const repeat = write("repeat.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "bash", "", Object.assign(new Opts(), { command: "git status" })),
    callLine(2, "bash", "", Object.assign(new Opts(), { command: "git status" })),
  ]);
  eq("repeat-command fires on the second run", ids(repeat, "repeat-command"), "2");
  const repeatEdit = write("repeat-edit.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "bash", "", Object.assign(new Opts(), { command: "git status" })),
    callLine(2, "edit", "a.txt"),
    callLine(3, "bash", "", Object.assign(new Opts(), { command: "git status" })),
  ]);
  eq("an edit between the commands stops repeat-command", ids(repeatEdit, "repeat-command"), "");

  const verify = write("verify.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "bash", "", Object.assign(new Opts(), { command: "node a.test.js", result: "all good" })),
    callLine(2, "bash", "", Object.assign(new Opts(), { command: "pnpm test", result: "pass" })),
  ]);
  eq("verify-after-pass fires on the second test run", ids(verify, "verify-after-pass"), "2");
  const verifyEdit = write("verify-edit.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "bash", "", Object.assign(new Opts(), { command: "node a.test.js", result: "all good" })),
    callLine(2, "edit", "a.txt"),
    callLine(3, "bash", "", Object.assign(new Opts(), { command: "pnpm test", result: "pass" })),
  ]);
  eq("an edit between the test runs stops verify-after-pass", ids(verifyEdit, "verify-after-pass"), "");
  const verifyFail = write("verify-fail.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "bash", "", Object.assign(new Opts(), { command: "npm test", result: "1 failed" })),
    callLine(2, "bash", "", Object.assign(new Opts(), { command: "npm test", result: "pass" })),
  ]);
  eq("a failing first test run stops verify-after-pass", ids(verifyFail, "verify-after-pass"), "");
  const verifyZero = write("verify-zero.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "bash", "", Object.assign(new Opts(), { command: "node test.mjs", result: "ok plain\nok quoted\n# fail 0" })),
    callLine(2, "bash", "", Object.assign(new Opts(), { command: "node test.mjs", result: "2 passed, 0 failed" })),
  ]);
  eq("a count of no failures is a pass", ids(verifyZero, "verify-after-pass"), "2");

  const registry = write("registry.jsonl", [
    runLine("t", "harness", true),
    callLine(1, "bash", "", Object.assign(new Opts(), { command: "npm view left-pad" })),
    callLine(2, "bash", "", Object.assign(new Opts(), { command: "cd /tmp && npm --silent view @scope/pkg time --json" })),
    callLine(3, "bash", "", Object.assign(new Opts(), { command: "npm install left-pad" })),
  ]);
  eq("package-manager-on-web fires on a registry command, its flags too, not on an install", ids(registry, "package-manager-on-web"), "1,2");
  const registryNoWeb = write("registry-noweb.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "bash", "", Object.assign(new Opts(), { command: "npm view left-pad" })),
  ]);
  eq("a registry command without web is no hit", ids(registryNoWeb, "package-manager-on-web"), "");

  const curl = write("curl.jsonl", [runLine("t", "harness", true), callLine(1, "bash", "", Object.assign(new Opts(), { command: "curl https://x" }))]);
  eq("web-through-bash fires on curl", ids(curl, "web-through-bash"), "1");
  const curlNoWeb = write("curl-noweb.jsonl", [runLine("t", "harness", false), callLine(1, "bash", "", Object.assign(new Opts(), { command: "curl https://x" }))]);
  eq("curl without web is no hit", ids(curlNoWeb, "web-through-bash"), "");

  const junk = write("junk.jsonl", [
    runLine("t", "harness", false),
    callLine(1, "read", "a.txt"),
    "{not json",
    callLine(2, "read", "a.txt"),
    "[]",
    textLine(3, "done"),
  ]);
  const parsed = readTranscript(junk);
  eq("an unparsable line is skipped", String(parsed.calls.length) + " " + String(parsed.texts.length) + " " + ids(junk, "reread"), "2 1 2");

  // Two agents, a setup failure left out, every section of the report.
  const reportDir = join(dir, "report");
  mkdirSync(reportDir);
  const inReport = (name: string, lines: string[]): void => {
    writeFileSync(join(reportDir, name), lines.join("\n") + "\n");
  };
  inReport("harness-1.jsonl", [
    runLine("alpha", "harness", true),
    callLine(1, "bash", "", Object.assign(new Opts(), { command: "curl https://x" })),
    callLine(2, "bash", "", Object.assign(new Opts(), { command: "npm view left-pad" })),
    callLine(3, "bash", "", Object.assign(new Opts(), { command: "git status" })),
    callLine(4, "bash", "", Object.assign(new Opts(), { command: "git status" })),
  ]);
  inReport("harness-2.jsonl", [
    runLine("beta", "harness", false),
    callLine(1, "bash", "", Object.assign(new Opts(), { command: "make", failed: true, result: "make: boom" })),
    callLine(2, "edit", "b.txt", Object.assign(new Opts(), { failed: true, result: "File has not been read" })),
    callLine(3, "read", "b.txt"),
    callLine(4, "write", "b.txt"),
  ]);
  inReport("opencode-1.jsonl", [
    runLine("alpha", "opencode", true),
    callLine(1, "read", "a.txt"),
    callLine(2, "read", "a.txt"),
    callLine(3, "bash", "", Object.assign(new Opts(), { command: "npm view left-pad" })),
  ]);
  inReport("opencode-setup.jsonl", [
    runLine("gamma", "opencode", true, true),
    callLine(1, "bash", "", Object.assign(new Opts(), { command: "make", failed: true, result: "setup died" })),
  ]);
  const expected = [
    "| detector | harness | opencode |",
    "|---|---|---|",
    "| refused-then-read | 1/1 | 0/0 |",
    "| reread | 0/0 | 1/1 |",
    "| read-after-edit | 0/0 | 0/0 |",
    "| failed-call | 2/1 | 0/0 |",
    "| repeat-command | 1/1 | 0/0 |",
    "| verify-after-pass | 0/0 | 0/0 |",
    "| package-manager-on-web | 1/1 | 1/1 |",
    "| web-through-bash | 1/1 | 0/0 |",
    "",
    "### refused-then-read",
    "A failed edit or write, a read of that path, then an edit or write of it.",
    "- beta, harness, harness-2.jsonl, call 3: read after its edit was refused",
    "",
    "### reread",
    "A read of a path already read in the run, with no edit or write between.",
    "- alpha, opencode, opencode-1.jsonl, call 2: read again with no edit between",
    "",
    "### failed-call",
    "Any call that failed, with its tool and result.",
    "- beta, harness, harness-2.jsonl, call 1: bash: make: boom",
    "- beta, harness, harness-2.jsonl, call 2: edit: File has not been read",
    "",
    "### repeat-command",
    "The same bash command run again with no edit or write between.",
    "- alpha, harness, harness-1.jsonl, call 4: same command run again: git status",
    "",
    "### package-manager-on-web",
    "A bash command that asks a package registry on a web task.",
    "- alpha, harness, harness-1.jsonl, call 2: package registry asked from bash: npm view left-pad",
    "- alpha, opencode, opencode-1.jsonl, call 3: package registry asked from bash: npm view left-pad",
    "",
    "### web-through-bash",
    "A bash command that runs curl or wget on a web task.",
    "- alpha, harness, harness-1.jsonl, call 1: curl rather than the web tools: curl https://x",
  ].join("\n");
  eq("flagsReport over two agents, a setup failure left out", flagsReport([reportDir]), expected);
  eq("no paths give an empty report", flagsReport([]), "");

  rmSync(dir, { recursive: true, force: true });
  done();
};

main();
