// The last rate-limit windows each agent reported, kept in `limits.json` so the status bar has them
// at start. An agent's windows are its own: another agent's limits (Claude Code's, say) are not
// shown for one that reports none. `Limits` and its windows come from the conversation package.
import { Limits } from "@widecode/conversation/session-store.ts";
import { join } from "node:path";
import { readTextOr, writeAtomic } from "@light/lib/fs.ts";
import { isRecord, num, text } from "@light/lib/json.ts";

interface WindowFields {
  usedPercent?: unknown;
  resetsAt?: unknown;
}

interface LimitFields {
  agent?: unknown;
  fiveHour?: unknown;
  sevenDay?: unknown;
  updatedMs?: unknown;
}

interface LimitsFields extends LimitFields {
  limits?: unknown;
}

const fields = (v: unknown): LimitsFields | null => (isRecord(v) ? (v as LimitsFields) : null);
const window = (v: unknown): WindowFields | null => (isRecord(v) ? (v as WindowFields) : null);

/** Set `l` from one agent's fields. */
const apply = (l: Limits, v: LimitsFields): Limits => {
  const five = window(v.fiveHour);
  const seven = window(v.sevenDay);
  if (five !== null) {
    l.fiveHour.usedPercent = num(five.usedPercent, -1);
    l.fiveHour.resetsAt = num(five.resetsAt, 0);
  }
  if (seven !== null) {
    l.sevenDay.usedPercent = num(seven.usedPercent, -1);
    l.sevenDay.resetsAt = num(seven.resetsAt, 0);
  }
  l.updatedMs = num(v.updatedMs, 0);
  return l;
};

/** An agent's windows as a written entry. */
const literal = (agent: string, l: Limits): unknown => ({
  agent,
  fiveHour: { usedPercent: l.fiveHour.usedPercent, resetsAt: l.fiveHour.resetsAt },
  sevenDay: { usedPercent: l.sevenDay.usedPercent, resetsAt: l.sevenDay.resetsAt },
  updatedMs: l.updatedMs,
});

export class LimitsStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Agent `agent`'s windows; a file from before agents (a flat one) is Claude Code's. */
  limits(agent = "claude"): Limits {
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
    if (Array.isArray(f.limits)) {
      for (const v of f.limits) {
        const e = fields(v);
        if (e !== null && text(e.agent, "") === agent) return apply(l, e);
      }
      return l;
    }
    return agent === "claude" ? apply(l, f) : l;
  }

  saveLimits(l: Limits, agent = "claude"): void {
    let entries: unknown[] = [];
    const raw = readTextOr(join(this.root, "limits.json"), "");
    if (raw.length > 0) {
      let value: unknown = null;
      try {
        value = JSON.parse(raw);
      } catch {
        value = null;
      }
      const f = fields(value);
      if (f !== null && Array.isArray(f.limits)) {
        for (const v of f.limits) {
          const e = fields(v);
          if (e === null || text(e.agent, "").length === 0) continue;
          if (text(e.agent, "") !== agent) entries.push(v);
        }
      } else if (f !== null && agent !== "claude" && (f.fiveHour !== undefined || f.sevenDay !== undefined)) {
        // A file from before agents: its windows stay Claude Code's as another agent's are added.
        entries.push({ agent: "claude", fiveHour: f.fiveHour, sevenDay: f.sevenDay, updatedMs: f.updatedMs });
      }
    }
    entries.push(literal(agent, l));
    const v: unknown = { limits: entries };
    try {
      writeAtomic(join(this.root, "limits.json"), JSON.stringify(v, null, 2) + "\n");
    } catch {
      // The status data is best effort: a read-only store must not stop a turn.
    }
  }
}
