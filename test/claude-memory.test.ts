// node-only
// A long Claude Code session: the plugin's engine must not grow with the turns it reads. The lines
// of 1900 turns (each with a 20 KiB tool result naming no call the model knows) go through the
// plugin as the CLI's stream does; past the core's turn cap the engine's growth is the plugin's
// raw lines. The run is a node process of its own, with a collection before each reading: under
// node the engine's memory is the process heap.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { done, ok } from "@lightstart/test/assert.ts";

const main = async (): Promise<void> => {
  const helper = join(process.cwd(), "test", "support", "claude-memory-run.ts");
  const run = spawnSync(process.execPath, ["--no-warnings", "--expose-gc", "--experimental-vm-modules", "--experimental-strip-types", "--import", "@lightstart/plugins/native/wcjs-node.mjs", helper], { cwd: process.cwd(), encoding: "utf8", timeout: 240000 });
  const line = run.stdout.split("\n").filter((l) => l.startsWith("claude-memory: {")).pop() ?? "";
  const read = (line.length > 0 ? JSON.parse(line.slice("claude-memory: ".length)) : null) as { turns: number; mid: number; end: number } | null;
  const grew = read === null ? -1 : read.end - read.mid;
  const perTurn = read === null ? -1 : grew / (read.turns - 1600);
  console.log("claude-memory: " + (read === null ? run.stderr.slice(-400) : String(Math.round(perTurn)) + " B/turn, " + String(grew) + " B over 300 turns"));
  ok("the plugin's engine does not grow with a long session's turns", run.status === 0 && read !== null && grew < 2 * 1024 * 1024);
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
