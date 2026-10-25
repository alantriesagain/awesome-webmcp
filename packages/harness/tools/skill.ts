// Skill: a skill's instructions by name, from the skills the session offers (the folder's when it
// is trusted, the user's, the harness's), for the model to follow.
import { str } from "@light/lib/json.ts";
import { scanSkills, skillText } from "../prompt/skills.ts";
import { ToolContext, ToolOutcome } from "./tool.ts";

export const skillTool = (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> =>
  new Promise<ToolOutcome>((settle) => {
    const name = str(input["name"]).trim().replace(/^\//, "");
    const skills = scanSkills(ctx.cwd, ctx.trusted, ctx.home, ctx.harnessRoot);
    const found = skills.find((s) => s.name === name) ?? null;
    if (found === null) {
      settle(ToolOutcome.failed("no skill named " + name + (skills.length > 0 ? "; the skills: " + skills.map((s) => s.name).join(", ") : "; there are none")));
      return;
    }
    const o = new ToolOutcome();
    o.text = skillText(found);
    o.locations = [found.path];
    settle(o);
  });
