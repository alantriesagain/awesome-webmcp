#!/usr/bin/env node
/**
 * @file A stand-in for the box script (`box/box.mjs`) in tests. It keeps the box's state in a JSON
 * file under `FAKE_BOX_DIR` (or `WIDECODE_BOX_DIR`, else a folder under the OS temp folder), and
 * records each `up`, `proxy` and `ssh` call, its arguments as JSON on a line, in
 * `FAKE_BOX_LOG` (else `fake-box.log` beside the state). `status --json` prints whether the box
 * runs, its projects and whether its proxy runs. `up` sets the box running with the folders it is
 * given (refusing another list, as the real box does), `proxy` stays alive until it is stopped,
 * and `ssh --forward-proxy N -- cmd...` runs the command on the host with the same stdio, so a
 * fake ACP agent runs through a boxed Task run.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = process.env.FAKE_BOX_DIR || process.env.WIDECODE_BOX_DIR || join(tmpdir(), "widecode-fake-box");
const statePath = join(dir, "fake-box.json");
const logPath = process.env.FAKE_BOX_LOG || join(dir, "fake-box.log");

const say = (msg) => process.stderr.write(`${msg}\n`);
const record = (line) => {
  mkdirSync(dir, { recursive: true });
  appendFileSync(logPath, JSON.stringify(line) + "\n");
};
const read = () => {
  try {
    const value = JSON.parse(readFileSync(statePath, "utf8"));
    return { running: value.running === true, projects: Array.isArray(value.projects) ? value.projects : [], proxy: value.proxy === true };
  } catch {
    return { running: false, projects: [], proxy: false };
  }
};
const write = (value) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(value) + "\n");
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const [command = "status", ...args] = process.argv.slice(2);

if (command === "status") {
  const state = read();
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(state) + "\n");
  } else {
    say(`running: ${state.running ? "yes" : "no"}`);
    say(`projects: ${state.projects.length > 0 ? state.projects.join(", ") : "none"}`);
    say(`proxy: ${state.proxy ? "running" : "not running"}`);
  }
  process.exit(0);
}

if (command === "up") {
  record({ cmd: "up", args });
  const folders = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--memory" || arg === "--cpus" || arg === "--port") {
      index += 1;
    } else if (arg.startsWith("--")) {
      continue;
    } else {
      folders.push(arg);
    }
  }
  const state = read();
  if (state.running) {
    if (same(state.projects, folders)) {
      say("the box already runs with these projects; nothing to do");
      process.exit(0);
    }
    say(`the box is running with ${state.projects.length ? state.projects.join(", ") : "no projects"}; the project list changed, so run down, then up again (one VM for every project)`);
    process.exit(1);
  }
  write({ running: true, projects: folders, proxy: state.proxy });
  say(`up with ${folders.join(", ")}`);
  process.exit(0);
}

if (command === "proxy") {
  record({ cmd: "proxy", args });
  const state = read();
  write({ running: state.running, projects: state.projects, proxy: true });
  say("proxy listening");
  const stop = () => {
    const now = read();
    write({ running: now.running, projects: now.projects, proxy: false });
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  setInterval(() => {}, 1000);
} else if (command === "ssh") {
  record({ cmd: "ssh", args });
  let index = args.indexOf("--");
  if (index < 0) index = args.length;
  const words = args.slice(index + 1);
  if (words.length === 0) process.exit(0);
  const child = spawn(words[0], words.slice(1), { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    process.exit(signal !== null ? 1 : code ?? 0);
  });
  child.on("error", (error) => {
    say(String(error));
    process.exit(1);
  });
} else {
  say(`unknown command "${command}"`);
  process.exit(2);
}
