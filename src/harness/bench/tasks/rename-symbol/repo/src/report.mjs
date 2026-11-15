import { fetchUserName } from "./users.mjs";

/** One line per id: the id and the user's name (fetchUserName gives "unknown" for a missing one). */
export const report = (ids) => ids.map((id) => String(id) + ": " + fetchUserName(id)).join("\n");
