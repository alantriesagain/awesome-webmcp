// The LS tool: a folder's entries by name, folders marked with a slash, 500 at most.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { str } from "@light/lib/json.ts";
import { resolvePath } from "./read.ts";
import { ToolContext, ToolOutcome } from "./tool.ts";

const MAX_ENTRIES = 500;

export const lsTool = (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> => {
  const given = str(input["path"]);
  const path = resolvePath(ctx.cwd, given.length > 0 ? given : ".");
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return done(ToolOutcome.failed("cannot list " + path));
  }
  names.sort();
  const shown: string[] = [];
  for (const name of names.slice(0, MAX_ENTRIES)) {
    let dir = false;
    try {
      dir = statSync(join(path, name)).isDirectory();
    } catch {
      dir = false;
    }
    shown.push(dir ? name + "/" : name);
  }
  const out = new ToolOutcome();
  out.locations.push(path);
  out.text = (shown.length > 0 ? shown.join("\n") : "(empty)") + (names.length > MAX_ENTRIES ? "\n(" + String(names.length - MAX_ENTRIES) + " more entries)" : "");
  return done(out);
};

const done = (o: ToolOutcome): Promise<ToolOutcome> => new Promise<ToolOutcome>((settle) => settle(o));
