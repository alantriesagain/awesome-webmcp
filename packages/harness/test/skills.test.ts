// The skills a session offers: the trusted folder's (`.agents/skills`, `.claude/skills`,
// `.pi/skills`, each plugin folder's `skills` under `.widecode/plugins`), the user's
// (`~/.agents/skills`, `~/.claude/skills`, its synced folders, named with their prefix, pi's agent
// folder, each plugin folder's `skills` under the store's `plugins`), the harness's; a name found
// twice is the first one's; a plugin folder without `index.js` is not a plugin; the frontmatter's
// name, its description over several lines, `disable-model-invocation` keeping one out of the
// prompt; an untrusted folder's left out; the side command's JSON; the prompt's section; the Skill
// tool's text, and its error naming the skills there are.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frontmatter, scanSkills, skillsJson, skillsSection, skillText } from "../prompt/skills.ts";
import { Abort } from "../loop/abort.ts";
import { ToolContext, ToolSet, builtInTools } from "../tools/tool.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const root = mkdtempSync(join(tmpdir(), "harness-skills-"));
const folder = join(root, "project");
const home = join(root, "home");
const harness = join(root, "store", "harness");
const piAgent = join(root, "pi-agent");
process.env["PI_CODING_AGENT_DIR"] = piAgent;
const skill = (dir: string, name: string, text: string): void => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), text);
};
const plugin = (dir: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), "// a plugin\n");
};
skill(join(folder, ".claude", "skills"), "release", "---\nname: release\ndescription: |\n  Cut a release:\n  tag, notes, publish.\n---\n# Release\n\nRun the steps.\n");
skill(join(folder, ".agents", "skills"), "deploy", "---\ndescription: \"Deploy the site\"\ndisable-model-invocation: true\n---\nDeploy it.\n");
skill(join(folder, ".pi", "skills"), "ship", "---\ndescription: Ship it\n---\nShip it.\n");
plugin(join(folder, ".widecode", "plugins", "beta"));
skill(join(folder, ".widecode", "plugins", "beta", "skills"), "project-skill", "---\ndescription: From the project plugin\n---\nProject skill.\n");
skill(join(folder, ".widecode", "plugins", "nope", "skills"), "ignored-skill", "---\ndescription: Not a plugin\n---\nIgnored.\n");
plugin(join(root, "store", "plugins", "zeta"));
plugin(join(root, "store", "plugins", "alpha"));
skill(join(root, "store", "plugins", "zeta", "skills"), "zskill", "---\ndescription: Zeta's skill\n---\nZeta.\n");
skill(join(root, "store", "plugins", "alpha", "skills"), "askill", "---\ndescription: Alpha's skill\n---\nAlpha.\n");
skill(join(home, ".claude", "skills"), "release", "---\ndescription: the user's release\n---\nNot this one.\n");
skill(join(home, ".claude", "skills"), "notes", "---\nname: notes\ndescription: Take notes\n---\nWrite them down.\n");
skill(join(home, ".claude", "skills", "synced", "abc"), "pdf", "---\ndescription: Read PDFs\n---\nUse pdftotext.\n");
skill(join(piAgent, "skills"), "pip", "---\ndescription: Pi's notes\n---\nPi notes.\n");
skill(join(harness, "skills"), "mine", "No frontmatter at all.\n");
mkdirSync(join(home, ".agents", "skills", "empty"), { recursive: true });

const fm = frontmatter("---\nname: x\ndescription: >\n  one\n  two\nother: 'q'\n---\nbody\n");
eq("the frontmatter's fields and the body after it", fm.fields.get("name") + "|" + fm.fields.get("description") + "|" + fm.fields.get("other") + "|" + fm.body, "x|one two|q|body\n");

const all = scanSkills(folder, true, home, harness);
eq("the folder's first, then its plugins', then the user's, the synced with their prefix, pi's, the store's plugins', the harness's; a folder without SKILL.md is none; a plugin folder without index.js is none", all.map((s) => s.name + ":" + s.source).join(" "), "deploy:project release:project ship:project project-skill:project notes:user anthropic-skills:pdf:user pip:user askill:user zskill:user mine:harness");
eq("the descriptions", all.map((s) => s.description).join(" | "), "Deploy the site | Cut a release: tag, notes, publish. | Ship it | From the project plugin | Take notes | Read PDFs | Pi's notes | Alpha's skill | Zeta's skill | ");
eq("an untrusted folder's left out: the user's release in its place, and the project's plugins too", scanSkills(folder, false, home, harness).map((s) => s.name + ":" + s.source).join(" "), "notes:user release:user anthropic-skills:pdf:user pip:user askill:user zskill:user mine:harness");
ok("as the side command prints them", skillsJson(all.slice(0, 1)) === '[{"name":"deploy","description":"Deploy the site","location":' + JSON.stringify(join(folder, ".agents", "skills", "deploy", "SKILL.md")) + "}]");
eq("the prompt's section: the listed ones", skillsSection(all).split("\n").slice(1).join("\n"), "- release: Cut a release: tag, notes, publish.\n- ship: Ship it\n- project-skill: From the project plugin\n- notes: Take notes\n- anthropic-skills:pdf: Read PDFs\n- pip: Pi's notes\n- askill: Alpha's skill\n- zskill: Zeta's skill\n- mine");
eq("no skills, no section", skillsSection([]), "");
eq("a skill's text: its folder, its body", skillText(all[1]), "The skill release, from " + join(folder, ".claude", "skills", "release") + ":\n\n# Release\n\nRun the steps.");

const main = async (): Promise<void> => {
  const tools = new ToolSet(builtInTools());
  const ctx = new ToolContext(folder, "build", new Set<string>());
  ctx.trusted = true;
  ctx.home = home;
  ctx.harnessRoot = harness;
  const got = await tools.run("Skill", '{"name":"notes"}', ctx, new Abort(), null);
  eq("the Skill tool gives the skill's text and file", got.text + " | " + got.locations.join(",") + " | " + String(got.isError), "The skill notes, from " + join(home, ".claude", "skills", "notes") + ":\n\nWrite them down. | " + join(home, ".claude", "skills", "notes", "SKILL.md") + " | false");
  const none = await tools.run("Skill", '{"name":"nope"}', ctx, new Abort(), null);
  eq("an unknown one: an error naming those there are", none.text + " | " + String(none.isError), "no skill named nope; the skills: deploy, release, ship, project-skill, notes, anthropic-skills:pdf, pip, askill, zskill, mine | true");
  rmSync(root, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
