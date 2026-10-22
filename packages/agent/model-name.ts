// Claude Code's model ids as names: "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5".
/** "claude-opus-5-5" → "Opus 5.5"; "claude-haiku-4-5-20251001" → "Haiku 4.5"; "[1m]" → " 1M"; the alias "fable[1m]" → "Fable 1M". */
export const modelName = (id: string): string => {
  const alias = /^(opus|fable|sonnet|haiku)(\[1m\])?$/.exec(id);
  if (alias !== null) return alias[1].charAt(0).toUpperCase() + alias[1].slice(1) + (alias[2] !== undefined ? " 1M" : "");
  if (!id.startsWith("claude-")) return id;
  const big = id.includes("[1m]");
  const parts = id.replace("[1m]", "").replace(/^claude-/, "").split("-");
  if (parts.length === 0 || !/^[a-z]+$/.test(parts[0])) return id;
  const version: string[] = [];
  for (let i = 1; i < parts.length; i++) if (/^\d{1,2}$/.test(parts[i])) version.push(parts[i]);
  return parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + (version.length > 0 ? " " + version.join(".") : "") + (big ? " 1M" : "");
};
