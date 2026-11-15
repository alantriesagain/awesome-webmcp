// The harness under node, for the app's tests and for development: the same `harnessMain` the
// binary runs for `widecode --harness`, over the store `--harness-home` names (else $WIDECODE_HOME,
// else ~/.widecode). Run from anywhere: `node src/harness/main.ts --harness --log <file>`.
import { homedir } from "node:os";
import { join } from "node:path";
import { harnessMain } from "./cli.ts";

const args = process.argv.slice(2);
const at = args.indexOf("--harness-home");
const env = process.env["WIDECODE_HOME"] ?? "";
const home = at >= 0 && at + 1 < args.length ? args[at + 1] : env.length > 0 ? env : join(homedir(), ".widecode");
void harnessMain(home, args, "dev", []).then((code: number) => process.exit(code));
