// A folder's records store for a test of the session records alone: the folder's `.lightcode/` as
// JSONL files over the sessions and skills models, as the app's `main` store opens it (src/app.ts),
// the model apis pointed at it until the next one opens.
import { join } from "node:path";
import { openJsonl } from "@lightstart/light/model/jsonl";
import type { Store } from "@lightstart/light/model/types.ts";
import { fileIO } from "@lightstart/app/tui/file.ts";
import { sessions } from "../../src/models/sessions.ts";
import { skills } from "../../src/models/skills.ts";

/** Open `folder`'s records store; close it before the next one opens. */
export const openFolderStore = (folder: string): Promise<Store> => {
  const dir = join(folder, ".lightcode");
  return openJsonl({ name: "main", dir, io: fileIO(dir), models: [sessions, skills] });
};
