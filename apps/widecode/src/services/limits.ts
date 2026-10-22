// The last rate-limit windows the agent reported, kept in `limits.json` so the status bar has them
// at start. `Limits` and its windows come from the conversation package.
import { Limits } from "@widecode/conversation/session-store.ts";
import { join } from "node:path";
import { readTextOr, writeAtomic } from "@light/lib/fs.ts";
import { isRecord, num } from "@light/lib/json.ts";

interface WindowFields {
  usedPercent?: unknown;
  resetsAt?: unknown;
}

interface LimitsFields {
  fiveHour?: unknown;
  sevenDay?: unknown;
  updatedMs?: unknown;
}

const fields = (v: unknown): LimitsFields | null => (isRecord(v) ? (v as LimitsFields) : null);
const window = (v: unknown): WindowFields | null => (isRecord(v) ? (v as WindowFields) : null);

export class LimitsStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  limits(): Limits {
    const l = new Limits();
    const raw = readTextOr(join(this.root, "limits.json"), "");
    if (raw.length === 0) return l;
    let value: unknown = null;
    try {
      value = JSON.parse(raw);
    } catch {
      return l;
    }
    const f = fields(value);
    if (f === null) return l;
    const five = window(f.fiveHour);
    const seven = window(f.sevenDay);
    if (five !== null) {
      l.fiveHour.usedPercent = num(five.usedPercent, -1);
      l.fiveHour.resetsAt = num(five.resetsAt, 0);
    }
    if (seven !== null) {
      l.sevenDay.usedPercent = num(seven.usedPercent, -1);
      l.sevenDay.resetsAt = num(seven.resetsAt, 0);
    }
    l.updatedMs = num(f.updatedMs, 0);
    return l;
  }

  saveLimits(l: Limits): void {
    const v: unknown = {
      fiveHour: { usedPercent: l.fiveHour.usedPercent, resetsAt: l.fiveHour.resetsAt },
      sevenDay: { usedPercent: l.sevenDay.usedPercent, resetsAt: l.sevenDay.resetsAt },
      updatedMs: l.updatedMs,
    };
    try {
      writeAtomic(join(this.root, "limits.json"), JSON.stringify(v, null, 2) + "\n");
    } catch {
      // The status data is best effort: a read-only store must not stop a turn.
    }
  }
}
