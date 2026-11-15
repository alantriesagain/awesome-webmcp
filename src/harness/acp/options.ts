// The session's config options as the ACP client reads them: three selects keyed by category,
// `model` (grouped by provider), `thought_level` (the effort) and `mode` (`build`, `plan`), each
// with its current value; the same shape opencode gives.
import { listText, objectText } from "@lightstart/lib/json.ts";

export class Choice {
  readonly value: string;
  readonly name: string;
  /** The provider a model belongs to ("" for a flat list). */
  readonly group: string;

  constructor(value: string, name: string, group: string) {
    this.value = value;
    this.name = name;
    this.group = group;
  }
}

const choiceText = (c: Choice): string => objectText(["value", "name"], [JSON.stringify(c.value), JSON.stringify(c.name)]);

/** Choices as the option's list: grouped when they carry groups, flat otherwise. */
const optionsText = (choices: Choice[]): string => {
  const groups: string[] = [];
  for (const c of choices) if (c.group.length > 0 && !groups.includes(c.group)) groups.push(c.group);
  if (groups.length === 0) return listText(choices.map(choiceText));
  return listText(groups.map((g) => objectText(["group", "name", "options"], [JSON.stringify(g), JSON.stringify(g), listText(choices.filter((c) => c.group === g).map(choiceText))])));
};

const selectText = (id: string, name: string, category: string, current: string, choices: Choice[]): string =>
  objectText(["id", "name", "category", "type", "currentValue", "options"], [JSON.stringify(id), JSON.stringify(name), JSON.stringify(category), '"select"', JSON.stringify(current), optionsText(choices)]);

export class ConfigOptions {
  models: Choice[] = [];
  efforts: Choice[] = [];
  modes: Choice[] = [new Choice("build", "Build", ""), new Choice("plan", "Plan", "")];
  model = "";
  effort = "";
  mode = "build";

  /** The `configOptions` list as JSON text. */
  text(): string {
    return listText([selectText("model", "Model", "model", this.model, this.models), selectText("effort", "Effort", "thought_level", this.effort, this.efforts), selectText("mode", "Mode", "mode", this.mode, this.modes)]);
  }

  /** Set option `id` to `value`; "" when done, else why not. */
  set(id: string, value: string): string {
    const among = id === "model" ? this.models : id === "effort" ? this.efforts : id === "mode" ? this.modes : null;
    if (among === null) return "no option " + id;
    if (!among.some((c) => c.value === value)) return "no " + id + " " + value;
    if (id === "model") this.model = value;
    else if (id === "effort") this.effort = value;
    else this.mode = value;
    return "";
  }

  copy(): ConfigOptions {
    const o = new ConfigOptions();
    o.models = this.models.slice();
    o.efforts = this.efforts.slice();
    o.modes = this.modes.slice();
    o.model = this.model;
    o.effort = this.effort;
    o.mode = this.mode;
    return o;
  }
}
