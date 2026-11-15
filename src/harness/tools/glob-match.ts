// A glob as a regular expression over a relative path: `**` any depth (a bare `**/` also none),
// `*` within a segment, `?` one character, `{a,b}` either, `[...]` a class; anchored at both ends.

const special = (c: string): string => (/[.+^$()|\\]/.test(c) ? "\\" + c : c);

export const globToRegExp = (pattern: string): RegExp => {
  let out = "";
  let i = 0;
  let inClass = false;
  while (i < pattern.length) {
    const c = pattern[i];
    if (inClass) {
      if (c === "]") inClass = false;
      out += c === "\\" ? "\\\\" : c;
      i++;
      continue;
    }
    if (c === "[") {
      inClass = true;
      out += "[";
      i++;
      continue;
    }
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const slash = pattern[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 3 : 2;
      } else {
        out += "[^/]*";
        i++;
      }
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close > i) {
        out += "(?:" + pattern.slice(i + 1, close).split(",").map((alt) => alt.split("").map(special).join("")).join("|") + ")";
        i = close + 1;
        continue;
      }
    }
    out += special(c);
    i++;
  }
  return new RegExp("^" + out + "$");
};

/** Whether `path` (relative, `/`-separated) matches `pattern`; a pattern without `/` matches a file's name at any depth. */
export const globMatches = (pattern: string, path: string): boolean => {
  const re = globToRegExp(pattern);
  if (re.test(path)) return true;
  if (!pattern.includes("/")) {
    const slash = path.lastIndexOf("/");
    return re.test(slash >= 0 ? path.slice(slash + 1) : path);
  }
  return false;
};
