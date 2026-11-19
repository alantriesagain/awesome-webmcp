// The keys the harness speaks to providers and search APIs with (Brave, Tavily, Exa): the
// environment variable first, then `~/.widecode/auth.json` (`{"<provider>": {"key": "..."}}`,
// readable by the user alone), which `widecode --harness-auth <provider>` writes from a line on
// stdin. No OAuth: a subscription's login is not a key the API takes.
import { chmodSync } from "node:fs";
import { readTextOr, writeAtomic } from "@lightstart/lib/fs.ts";
import { objectText, parseJson, recordOf, str } from "@lightstart/lib/json.ts";
import { Provider } from "./model/registry.ts";

export class Auth {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** The key for `p`: its environment variable, else the file's entry; "" for none. */
  keyFor(p: Provider): string {
    if (p.keyEnv.length > 0) {
      const env = process.env[p.keyEnv] ?? "";
      if (env.length > 0) return env;
    }
    const root = recordOf(parseJson(readTextOr(this.path, "{}")));
    const entry = root !== null ? recordOf(root[p.id]) : null;
    return entry !== null ? str(entry["key"]) : "";
  }

  /** Keep `key` for provider `id` in the file, readable by the user alone. */
  writeKey(id: string, key: string): void {
    const root = recordOf(parseJson(readTextOr(this.path, "{}"))) ?? {};
    const ids: string[] = [];
    for (const k of Object.keys(root)) if (k !== id) ids.push(k);
    const keys: string[] = [];
    const values: string[] = [];
    for (const k of ids) {
      keys.push(k);
      values.push(JSON.stringify(root[k]));
    }
    keys.push(id);
    values.push(objectText(["key"], [JSON.stringify(key)]));
    writeAtomic(this.path, objectText(keys, values) + "\n");
    chmodSync(this.path, 0o600);
  }
}
