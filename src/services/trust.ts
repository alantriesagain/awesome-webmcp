// The folders the user trusts: the agent works there and the folder's harness runs. The list is
// `trusted.json` under the store, written whole when a folder is added.
import { join } from "node:path";
import { readTextOr, writeAtomic } from "@light/lib/fs.ts";

export class TrustStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Whether the user trusts `folder`. */
  trusted(folder: string): boolean {
    return this.folders().includes(folder);
  }

  /** Trust `folder` from now on. */
  trust(folder: string): void {
    const list = this.folders();
    if (list.includes(folder)) return;
    list.push(folder);
    writeAtomic(join(this.root, "trusted.json"), JSON.stringify(list, null, 2) + "\n");
  }

  private folders(): string[] {
    const out: string[] = [];
    let value: unknown = null;
    try {
      value = JSON.parse(readTextOr(join(this.root, "trusted.json"), ""));
    } catch {
      return out;
    }
    if (Array.isArray(value)) for (const f of value as unknown[]) if (typeof f === "string") out.push(f);
    return out;
  }
}
