// Prompt templates in pi's format: the args of a command line with shell-like quoting; each
// placeholder form (`$1`, `$@`, `$ARGUMENTS`, `${1:-default}`, `${@:-default}`, `${@:N}`,
// `${@:N:L}`) and a missing argument empty; the scan's folders in order, first found wins by name,
// only direct `.md` children, the description from the frontmatter or the body's first line cut to
// 60 characters, the argument hint, pi's agent folder from `PI_CODING_AGENT_DIR` or `~/.pi/agent`,
// and a trusted folder's templates left out while it is not trusted.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemplateInfo, expandTemplate, scanTemplates, splitArgs, substituteArgs } from "../prompt/templates.ts";
import { done, eq } from "@light/test/assert.ts";

const root = mkdtempSync(join(tmpdir(), "harness-prompts-"));
const folder = join(root, "project");
const home = join(root, "home");
const harness = join(root, "store", "harness");
const piAgent = join(root, "pi-agent");
process.env["PI_CODING_AGENT_DIR"] = piAgent;
const template = (dir: string, name: string, text: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name + ".md"), text);
};

template(join(folder, ".widecode", "prompts"), "review", "---\ndescription: Review a change\nargument-hint: <path>\n---\nReview $1 in $2.\n");
template(join(folder, ".pi", "prompts"), "project", "---\ndescription: Pi project\n---\nProject it.\n");
template(join(harness, "prompts"), "review", "---\ndescription: Harness review\n---\nHarness review.\n");
template(join(harness, "prompts"), "notes", "---\ndescription: Harness notes\n---\nTake notes.\n");
template(join(piAgent, "prompts"), "env", "---\ndescription: Env template\n---\nEnv.\n");
const long = "A description line much longer than sixty characters so that the fallback cuts it short";
template(join(piAgent, "prompts"), "fallback", "\n\n  " + long + "\nA second line.\n");
template(join(home, ".pi", "agent", "prompts"), "default", "---\ndescription: Default pi\n---\nDefault.\n");
template(join(folder, ".widecode", "prompts", "nested"), "deep", "---\ndescription: Nested\n---\nDeep.\n");
writeFileSync(join(folder, ".widecode", "prompts", "readme.txt"), "not a template\n");

eq("the words of a command line", splitArgs('one "two three" \'four five\' six\\ seven ""').map((a) => "[" + a + "]").join("|"), "[one]|[two three]|[four five]|[six seven]|[]");
eq("a backslash keeps the next character", splitArgs("a\\ b\tc").join("|"), "a b|c");

const body = "A $1 B ${1:-def} C $2 D ${2:-def} E $@ F ${@:-def} G ${@:2} H ${@:2:2} I $ARGUMENTS J $9 K ${@:9}";
eq("each placeholder with three arguments", substituteArgs(body, ["x", "y", "z"]), "A x B x C y D y E x y z F x y z G y z H y z I x y z J  K ");
eq("a missing positional is empty and a default stands for it", substituteArgs(body, []), "A  B def C  D def E  F def G  H  I  J  K ");
eq("the all-arguments default when some are given is the arguments", substituteArgs("${@:-none}", ["a", "b"]), "a b");
eq("a slice past the end is empty", substituteArgs("${@:5}", ["a"]), "");
eq("zero starts at the first argument", substituteArgs("${@:0:2}", ["a", "b"]), "a b");

const all = scanTemplates(folder, true, home, harness);
eq("the project's folders, then the harness's, then pi's; a name found twice is the first one's; only direct .md files", all.map((t) => t.name + ":" + t.source).join(" "), "review:project project:project notes:harness env:user fallback:user");
eq("the descriptions, the body's first line cut to 60 characters", all.map((t) => t.description).join(" | "), "Review a change | Pi project | Harness notes | Env template | " + long.slice(0, 60));
eq("the argument hint", all.map((t) => t.argumentHint).join("|"), "<path>||||");
eq("an untrusted folder's are left out", scanTemplates(folder, false, home, harness).map((t) => t.name + ":" + t.source).join(" "), "notes:harness review:harness env:user fallback:user");

const made = new TemplateInfo("made", "/nowhere", "user");
made.body = "Say $1 to $2.\n";
eq("a template expands from its name and the quoted words after it", expandTemplate("/made 'a b' c", [made]), "Say a b to c.\n");
eq("a name not there is the text as it came", expandTemplate("/nope x", [made]), "/nope x");
eq("a line that is not a command is the text as it came", expandTemplate("made x", [made]), "made x");
eq("the scanned template expands", expandTemplate('/review "a b" c', all), "Review a b in c.\n");

delete process.env["PI_CODING_AGENT_DIR"];
eq("without the variable pi's agent folder is under the home", scanTemplates(folder, true, home, harness).map((t) => t.name + ":" + t.source).join(" "), "review:project project:project notes:harness default:user");

rmSync(root, { recursive: true, force: true });
done();
