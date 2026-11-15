import { loadUserName } from "./users.mjs";

/** One line per id: the id and the user's name (loadUserName gives "unknown" for a missing one). */
export const report = (ids) => ids.map((id) => String(id) + ": " + loadUserName(id)).join("\n");
