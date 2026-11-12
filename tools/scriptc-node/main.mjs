#!/usr/bin/env node
// scriptc's command line, run under node: upstream's packages/cli/src/main.ts at v0.4.12 over the
// published @scriptc/compiler, unchanged but for where the version and the WASI runner come from.
// npm's scriptc package runs a natively compiled copy of this compiler, which segfaults on
// apps/widecode/src/main.ts; this one compiles it. Replace this folder with the npm `scriptc`
// package once a release fixes the crash.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  analyzeCached,
  collectGarbageUnderHeapPressure,
  compile,
  compileLibrary,
  mergeProfiles,
  resolveProvenanceSources,
  sourceTargetPlatform,
  typePatches,
  warmNativeCaches,
} from "@scriptc/compiler";
import { runCli } from "@scriptc/compiler/cli/command";

const version = () => JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version ?? "unknown";

// The compiler process collects its heap as lowering and LLVM emission grow it.
collectGarbageUnderHeapPressure();

process.exitCode = await runCli(process.argv.slice(2), {
  version,
  analyze: analyzeCached,
  compile,
  compileLibrary,
  resolveProvenanceSources,
  sourceTargetPlatform,
  warmNativeCaches,
  mergeProfiles,
  typePatches,
  reinvoke: (args) => ({
    file: process.execPath,
    args: [...process.execArgv, process.argv[1], ...args],
  }),
  run: (binary) =>
    new Promise((resolveExit) => {
      let child;
      if (sourceTargetPlatform() === "wasi") {
        const runner = fileURLToPath(import.meta.resolve("@scriptc/compiler/cli/wasi-runner"));
        child = spawn(process.execPath, [...process.execArgv, "--no-warnings", runner, binary], {
          stdio: "inherit",
        });
      } else child = spawn(binary, [], { stdio: "inherit" });
      child.on("exit", (code, signal) => {
        if (signal) {
          process.stderr.write(`scriptc: program killed by ${signal}\n`);
          resolveExit(1);
        } else resolveExit(code ?? 0);
      });
    }),
});
