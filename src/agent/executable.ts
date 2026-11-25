// The Claude Code CLI lightcode runs itself (the session titles), found as the claude plugin finds
// the agent's own on the plugin API.
import { existsSync } from "node:fs";

/**
 * The CLI to run for `given`: the path given (`--claude`), else `claude` in a directory of `path`
 * (PATH's value), else the installer's `~/.local/bin/claude` under `home`, else the bare name. The
 * claude plugin resolves the agent's own the same way, on the plugin API.
 */
export const claudeExecutable = (given: string, path: string, home: string): string => {
  if (given.length > 0) return given;
  for (const dir of path.split(":")) if (dir.length > 0 && existsSync(dir + "/claude")) return dir + "/claude";
  const local = home + "/.local/bin/claude";
  return existsSync(local) ? local : "claude";
};
