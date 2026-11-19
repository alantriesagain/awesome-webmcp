// A built-in plugin's folder carries the build it belongs to (`.widecode-build`, written by
// scripts/builtin-plugins.mjs and copied by `light install`): a running binary may load the plugins
// of its own build only, so a newer install's plugins wait for a restart. A folder without the file
// (the user's own plugin, the project's harness plugins) carries no build and loads as it always did.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The file scripts/builtin-plugins.mjs writes into each built-in plugin's folder with its build. */
export const BUILD_STAMP = ".widecode-build";

/** The build `file`'s folder was written for ("" when it has no stamp, so it is no built-in's). */
export const stampedBuild = (file: string): string => {
  try {
    return readFileSync(join(dirname(file), BUILD_STAMP), "utf8").trim();
  } catch {
    return "";
  }
};

/** Whether `file` is a built-in plugin from a build other than `own` (a newer widecode was installed while this one runs). */
export const fromOtherBuild = (file: string, own: string): boolean => {
  const build = stampedBuild(file);
  return build.length > 0 && build !== own;
};
