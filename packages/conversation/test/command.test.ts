// A command's segments and the programs they name: chains, pipes, quotes, substitutions,
// heredocs, compounds, wrappers, assignments and subcommands.
import { programCounts, programOf, programsOf, segments } from "../command.ts";
import { done, eq } from "@light/test/assert.ts";

const segs = (command: string): string => segments(command).join(" ¦ ");
const progs = (command: string): string => programsOf(command).join(", ");

eq("a chain splits at && and ;", segs("cd x && git status; ls"), "cd x ¦ git status ¦ ls");
eq("a pipe splits too", segs("ps -eo rss | grep widecode | awk '{s+=$1}'"), "ps -eo rss ¦ grep widecode ¦ awk '{s+=$1}'");
eq("|| and |& split, 2>&1 and &> do not", segs("a || b |& c 2>&1 &> log"), "a ¦ b ¦ c 2>&1 &> log");
eq("a background & splits", segs("sleep 1 & wait"), "sleep 1 ¦ wait");
eq("operators inside quotes stay", segs("echo 'a && b' && echo \"c | d\""), "echo 'a && b' ¦ echo \"c | d\"");
eq("a substitution stays whole", segs("for f in $(git ls-files 'a;b'); do wc -l $f; done"), "for f in $(git ls-files 'a;b'); do wc -l $f; done");
eq("a group stays whole", segs("(cd x && make) && echo ok"), "(cd x && make) ¦ echo ok");
eq("newlines split outside quotes", segs("npm test\nnpm run lint"), "npm test ¦ npm run lint");
eq("a heredoc stays one segment", segs("cat > f <<'EOF'\nline; one\nEOF\ngit add f"), "cat > f <<'EOF'\nline; one\nEOF ¦ git add f");
eq("a comment is dropped", segs("ls # list && things\npwd"), "ls ¦ pwd");

eq("a program is its first word", programOf("ls -la /tmp"), "ls");
eq("a subcommand is kept", programOf("git -C /x status --short"), "git status");
eq("flags before a subcommand are skipped", programOf("pnpm -r --filter a install"), "pnpm install");
eq("a path to a program is its name", programOf("/usr/bin/node --test a.js"), "node");
eq("assignments and wrappers are skipped", programOf("FOO=1 sudo env time make -j"), "make");
eq("a compound is its keyword", programOf("for f in *; do echo $f; done"), "for");
eq("but a command's programs are what a compound's body runs", progs("for f in $(ls); do wc -l $f || true; done; if test -f x; then make; else cargo build; fi"), "wc, test, make, cargo build");
eq("cd, echo, sleep and the like say nothing", [programOf("cd /x"), programOf("echo hi"), programOf("export A=1"), programOf("sleep 6")].join("|"), "|||");
eq("a bare assignment says nothing", programOf("A=1"), "");
eq("a substitution as the command says nothing", programOf("$(which x) --v"), "");

eq("a command's programs, each once, in order", progs("cd /x && git status && git log -1 && ls | wc -l"), "git status, git log, ls, wc");
eq("an empty command runs nothing", progs("   "), "");
eq("counts across commands, most first then by name", programCounts(["git status", "git status && ls", "ls | wc -l"]).map((c) => c.program + "×" + String(c.calls)).join(" "), "git status×2 ls×2 wc×1");

done();
