// lightcode was widecode: its store was ~/.widecode and a project's folder .widecode/. Each is moved
// to the new name once, by a rename, the first time lightcode looks for it and finds only the old
// one. Nothing is copied, so a store or a folder is never left in two places.
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The store's and a project's folder name before the rename. */
const OLD = ".widecode";

/** Move `old` to `now` when only `old` is there; true when it moved. */
const moveOnce = (old: string, now: string): boolean => {
  if (existsSync(now) || !existsSync(old)) return false;
  try {
    renameSync(old, now);
    return true;
  } catch {
    return false;
  }
};

/** Move `home`'s .widecode to the default store `root` (~/.lightcode) once: what the status bar says, "" when nothing moved. */
export const moveOldStore = (root: string, home: string = homedir()): string => (moveOnce(join(home, OLD), root) ? "moved ~/" + OLD + " to " + root : "");

/** Project `dir`'s .lightcode/, its .widecode/ moved there first if that is all it has. */
export const projectFolder = (dir: string): string => {
  const now = join(dir, ".lightcode");
  moveOnce(join(dir, OLD), now);
  return now;
};
