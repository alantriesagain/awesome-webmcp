// What the agent lets the user choose: a setting by category, its select's options and values, and
// an option a permission offers.

import { obj, str, list } from "./json.ts";

/** A setting the agent offers: its config option's id ("" for the older set_mode and set_model), its options and their values, the current one. */
export interface Setting {
  id: string;
  options: widecode.AgentOption[];
  values: string[];
  current: string;
}

export const setting = (id: string, options: widecode.AgentOption[], current: string): Setting => ({ id, options, values: options.map((o) => o.value), current });

/** A select's options, its groups' included. */
export const optionsOf = (options: unknown): widecode.AgentOption[] => {
  const out: widecode.AgentOption[] = [];
  for (const x of list(options)) {
    const o = obj(x);
    if (o === null) continue;
    if (typeof o.value === "string") out.push({ value: o.value, name: str(o.name).length > 0 ? str(o.name) : o.value });
    else out.push(...optionsOf(o.options));
  }
  return out;
};

/** An option the agent offers for a permission, as ACP names its kind. */
export interface Option {
  optionId: string;
  name: string;
  kind: string;
}
