// The title job's CLI: --claude's path as given; else `claude` in a PATH directory; else the
// installer's ~/.local/bin/claude; else the bare name, as the claude plugin resolves the agent's own.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeExecutable } from "@widecode/agent";
import { done, eq } from "@light/test/assert.ts";

const root = mkdtempSync(join(tmpdir(), "widecode-claude-exe-"));
const binA = join(root, "a");
const binB = join(root, "b");
const home = join(root, "home");
mkdirSync(binA);
mkdirSync(binB);
mkdirSync(home);
mkdirSync(join(home, ".local"));
mkdirSync(join(home, ".local", "bin"));
writeFileSync(join(binB, "claude"), "#!/bin/sh\n");

eq("a given path is taken as it is", claudeExecutable("/opt/claude", binA + ":" + binB, home), "/opt/claude");
eq("else the first PATH directory holding claude", claudeExecutable("", binA + ":" + binB, home), join(binB, "claude"));
eq("empty PATH entries are skipped", claudeExecutable("", ":" + binB, home), join(binB, "claude"));
eq("without one on PATH, the bare name", claudeExecutable("", binA, home), "claude");
writeFileSync(join(home, ".local", "bin", "claude"), "#!/bin/sh\n");
eq("the installer's default comes before the bare name", claudeExecutable("", binA, home), join(home, ".local", "bin", "claude"));
eq("and after PATH", claudeExecutable("", binA + ":" + binB, home), join(binB, "claude"));
rmSync(root, { recursive: true, force: true });
done();
