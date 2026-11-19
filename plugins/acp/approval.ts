// What an approval mode does with one permission request: allowed at once, rejected at once, or put
// to the request panel. The mode and the decision are strings, so a test can drive this alone.

/** What a mode decides for a permission request. */
export type Decision = "allow" | "reject" | "ask";

/** The kinds a call may have and still go through in "auto". */
const AUTO_KINDS = ["read", "edit", "search", "think"];

/** A path with its "." and ".." segments resolved, absolute paths kept absolute. */
const normalize = (path: string): string => {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
    } else parts.push(segment);
  }
  return (absolute ? "/" : "") + parts.join("/");
};

/** Whether `path` (absolute, or relative to `folder`) is `folder` or inside it. */
const inside = (path: string, folder: string): boolean => {
  if (folder.length === 0 || path.startsWith("~")) return false;
  const root = normalize(folder);
  const full = normalize(path.startsWith("/") ? path : root + "/" + path);
  return full === root || full.startsWith(root === "/" ? "/" : root + "/");
};

/**
 * What mode `mode` does with a call of `kind` naming `paths` in `folder`: "allow", "reject" or
 * "ask". Any mode other than "auto" and "full" asks, as "plan" rejects.
 */
export const approve = (mode: string, kind: string, paths: string[], folder: string): Decision => {
  if (mode === "full") return "allow";
  if (mode === "plan") return "reject";
  if (mode !== "auto") return "ask";
  if (!AUTO_KINDS.includes(kind)) return "ask";
  for (const path of paths) if (!inside(path, folder)) return "ask";
  return "allow";
};

/** The path fields a call's input may carry. */
const PATH_KEYS = ["path", "file_path", "filePath", "paths", "files"];

/** Every path a tool call names: its locations' and its input's path fields. */
export const pathsOf = (locations: string[], input: Record<string, unknown> | null): string[] => {
  const out = locations.slice();
  if (input !== null) {
    for (const key of PATH_KEYS) {
      const value = input[key];
      if (typeof value === "string") out.push(value);
      else if (Array.isArray(value)) for (const one of value) if (typeof one === "string") out.push(one);
    }
  }
  return out;
};
