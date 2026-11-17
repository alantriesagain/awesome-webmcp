// widecode --harness: widecode's own agent, speaking ACP on stdio instead of the interface. It
// shares nothing with the app below but the binary and its log: no terminal, no folder. Its
// built-in plugins are the ones beside the binary (a development build's dist/plugins), else the
// ones `light install` wrote into the user's plugin folder, which it reads anyway.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { sourcesIn } from "@lightstart/plugins/sources.ts";
import { BUILD } from "../build.ts";
import { harnessMain, isHarnessArgs } from "../harness/cli.ts";
import { Store } from "../services/store.ts";

export const matches = (argv: readonly string[]): boolean => isHarnessArgs(argv.slice());

export const main = (argv: readonly string[]): Promise<number> => {
  const beside = join(dirname(process.execPath), "plugins");
  return harnessMain(Store.defaultRoot(), argv.slice(), BUILD, existsSync(beside) ? sourcesIn(beside) : []);
};
