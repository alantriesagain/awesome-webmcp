// ffi: @lightstart/plugins/native/ffi.json
// The status bar's data from recorded CLI traffic, read by Claude Code's plugin: context (the last
// main request's input over the window the result reports), prompt cache (requests, misses, hit
// ratio, TTL), rate limits, tool counts and calls, thinking, lines changed; the same counts from the
// session's transcript, resumed, as from its live run, with the cost from the transcript's
// cost-state; the Claude Code status line JSON.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelName, StatusInfo } from "../src/conversation/status-info.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { projectDir } from "./support/claude-records.ts";

const fixtures = join(process.cwd(), "test", "fixtures");

interface Frame {
  dir?: unknown;
  raw?: unknown;
}

const counts = (s: StatusInfo): string =>
  "ctx " + String(s.contextUsed) + "/" + String(s.windowSize) + " req " + String(s.requests) + " miss " + String(s.misses) + " hit " + s.hitRatio().toFixed(3) + " ttl " + String(s.cacheTtlMs / 60000) + "m R" + String(s.reads) + " W" + String(s.writes) + " X" + String(s.execs) + " A" + String(s.agents) + " calls " + String(s.calls) + " think " + String(s.thinking) + " +" + String(s.linesAdded) + " -" + String(s.linesRemoved);

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-status-"));
  const projects = join(folder, ".projects");
  const config: unknown = { claude: { projects } };
  const w = await openWidecode({ folder, plugins: config });
  const c = w.host.conversation;

  /** The status after a fixture's CLI lines. */
  const live = (name: string): StatusInfo => {
    c.reset();
    for (const line of readFileSync(join(fixtures, name + ".ndjson"), "utf8").split("\n")) {
      if (line.length === 0) continue;
      const f = JSON.parse(line) as Frame;
      if (f.dir !== "out" || typeof f.raw !== "string") continue;
      c.receive(f.raw);
    }
    return c.info;
  };

  const edit = live("edit");
  eq("edit: context, cache, tools, thinking, lines", counts(edit), "ctx 20858/200000 req 3 miss 0 hit 0.917 ttl 60m R0 W2 X0 A0 calls 2 think 267 +1 -1");
  eq("edit: model, mode, version", edit.modelId + " " + edit.mode + " " + edit.version, "claude-haiku-4-5-20251001 bypassPermissions 2.1.282");
  eq("limits: five hours and seven days", String(edit.fiveHourPct) + "% " + String(edit.weekPct) + "% " + String(edit.fiveHourResets > 0 && edit.weekResets > edit.fiveHourResets), "5% 65% true");
  const editJson = edit.json(Date.now());
  const sub = live("subagent");
  eq("subagent: its Read counts, its context and cache do not", counts(sub), "ctx 21282/200000 req 3 miss 0 hit 0.911 ttl 60m R1 W0 X0 A1 calls 2 think 172 +0 -0");

  // The same session's transcript, resumed on the model it ran on. The fixture leaves out records
  // between some messages (attachments, system lines): each message is linked to the one before,
  // as those records linked them, so the whole conversation is on its active branch.
  mkdirSync(projectDir(projects, folder), { recursive: true });
  const linked: string[] = [];
  let previous = "";
  for (const line of readFileSync(join(fixtures, "edit.transcript.jsonl"), "utf8").split("\n")) {
    if (line.length === 0) continue;
    const r = JSON.parse(line) as { uuid?: unknown; parentUuid?: unknown };
    if (typeof r.uuid === "string") {
      if (previous.length > 0) r.parentUuid = previous;
      previous = r.uuid;
    }
    linked.push(JSON.stringify(r));
  }
  writeFileSync(join(projectDir(projects, folder), "edit.jsonl"), linked.join("\n") + "\n");
  c.modelName = "haiku";
  c.resume("edit", "");
  const t = c.info;
  eq("the transcript gives the live run's counts", counts(t), counts(edit));
  eq("and its cost from the cost-state record", t.costUsd.toFixed(5), "0.01809");
  ok("and a start time from its timestamps", t.startMs > 1700000000000);

  const json = JSON.parse(editJson) as { context_window?: { used_percentage?: unknown; context_window_size?: unknown }; prompt_cache?: { ttl?: unknown; requests?: unknown }; rate_limits?: { five_hour?: { used_percentage?: unknown } }; model?: { display_name?: unknown }; widecode?: { writes?: unknown } };
  eq("the status line JSON a Claude Code script reads", [json.context_window?.used_percentage, json.context_window?.context_window_size, json.prompt_cache?.ttl, json.prompt_cache?.requests, json.rate_limits?.five_hour?.used_percentage, json.model?.display_name, json.widecode?.writes].map((v) => String(v)).join(" "), "10 200000 1h 3 5 Haiku 4.5 2");
  eq("model names", ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-fable-5-1", "custom"].map(modelName).join(", "), "Opus 5.5, Opus 5.5 1M, Haiku 4.5, Sonnet 5, Fable 5.1, custom");
  const big = new StatusInfo();
  big.modelId = "claude-opus-5-5[1m]";
  eq("a [1m] model's window before any result", String(big.windowSize), "1000000");

  closeWidecode(w);
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
