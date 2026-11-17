// What runs an entry's commands: a word quoted for sh, and the line that runs a command in a
// folder for what it prints, through a file so a large listing is not lost to a pipe.

/** A word for `sh`, quoted. */
export const quote = (w: string): string => "'" + w.replace(/'/g, "'\\''") + "'";

/**
 * The shell line that runs `words` in `folder` for what they print: their output goes to a file,
 * then to the plugin. An agent's CLI that writes a large listing and exits without waiting for it
 * to drain (opencode's, under Bun) loses what a pipe could not hold, 64 KB natively, and its JSON
 * no longer parses; a file holds it all, and `cat` waits for the pipe.
 */
export const throughFile = (folder: string, words: string[]): string =>
  "cd " + quote(folder) + ' && f=$(mktemp) && { ' + words.map(quote).join(" ") + ' > "$f"; c=$?; cat "$f"; rm -f "$f"; exit $c; }';
