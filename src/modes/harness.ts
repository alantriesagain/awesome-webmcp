// widecode --harness: widecode's own agent, speaking ACP on stdio instead of the interface. It
// shares nothing with the app below but the binary and its log: no terminal, no folder.
import { BUILD } from "../build.ts";
import { harnessMain, isHarnessArgs } from "../harness/cli.ts";
import { BUILTIN_PLUGINS } from "../runtime/builtin.ts";
import { Store } from "../services/store.ts";

export const matches = (argv: readonly string[]): boolean => isHarnessArgs(argv.slice());

export const main = (argv: readonly string[]): Promise<number> => harnessMain(Store.defaultRoot(), argv.slice(), BUILD, BUILTIN_PLUGINS);
