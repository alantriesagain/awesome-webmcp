// The system prompt's blocks: the base text (who the agent is, where it works, how to answer),
// then the project's text the ACP client passes (widecode's fixed paragraph and the project's
// prompt.md), both stable within a session so a provider can cache them. The tools' guidance,
// the context files and the skills join in later slices.

const BASE =
  "You are the harness, widecode's coding agent, working in the user's project folder from a terminal. " +
  "Read before you change, keep changes small and explain what you did in a few plain sentences. " +
  "Answer in terse markdown. Never claim to have done what you did not do.";

/** The blocks for a session in `cwd` on `platform`, with the project's `harnessText` ("" for none). */
export const systemBlocks = (cwd: string, platform: string, harnessText: string): string[] => {
  const out: string[] = [BASE + "\n\nThe folder: " + cwd + "\nThe platform: " + platform];
  if (harnessText.trim().length > 0) out.push(harnessText.trim());
  return out;
};
