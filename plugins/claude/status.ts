// The status Claude Code's status line gets (lightcode.StatusFields) and the limit helpers: the
// context, cache, rate limits, cost and tokens, and what a rate limit message says and when it
// resets.

import type { Rec } from "./records.ts";
import { rec, str, num, list } from "./records.ts";

/** What Claude Code says when a rate limit stops a turn; "" for any other result. */
const LIMIT_WORDS = /(session|weekly|week|usage|rate|five[- ]hour|5[- ]hour)\s+limit|hit your .{0,24}limit|limit (?:reached|exceeded)|out of (?:usage|credits)/i;
export const limitMessage = (r: Rec): string => {
  if (r.is_error !== true) return "";
  const parts: string[] = [];
  for (const e of list(r.errors)) if (typeof e === "string") parts.push(e);
  if (str(r.result).length > 0) parts.push(str(r.result));
  if (str(r.subtype).length > 0) parts.push(str(r.subtype));
  const text = parts.join("\n").trim();
  return LIMIT_WORDS.test(text) ? text : "";
};

/** Message ids remembered so one message's usage is counted once; long past ones can be forgotten. */
const MESSAGES_MAX = 5000;
const unitMs = (unit: string): number => {
  const c = unit.charAt(0).toLowerCase();
  return c === "d" ? 86400000 : c === "h" ? 3600000 : c === "m" ? 60000 : 1000;
};

/** When a limit message says it resets (epoch ms; 0 when it does not say). "resets in 3h 20m" first, then a clock time on this machine. */
export const resetFrom = (text: string, now: number): number => {
  const lower = text.toLowerCase();
  const inHours = /resets?\s+in\s+(\d+)\s*(?:h|hr|hrs|hour|hours)(?:\s+(\d+)\s*(?:m|min|mins|minute|minutes))?/.exec(lower);
  if (inHours !== null) return now + Number(inHours[1]) * 3600000 + Number(inHours[2] ?? "0") * 60000;
  const inOne = /resets?\s+in\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)/.exec(lower);
  if (inOne !== null) return now + Number(inOne[1]) * unitMs(inOne[2]);
  const pm = /resets?\s+(?:at\s+|around\s+|before\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(lower);
  if (pm !== null) {
    let hour = Number(pm[1]) % 12;
    if (pm[3] === "pm") hour += 12;
    const d = new Date(now);
    d.setHours(hour, Number(pm[2] ?? "0"), 0, 0);
    const at = d.getTime();
    return at > now ? at : at + 86400000;
  }
  const clock = /resets?\s+(?:at\s+|around\s+)?(\d{1,2}):(\d{2})\b/.exec(lower);
  if (clock !== null) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    const at = d.getTime();
    return at > now ? at : at + 86400000;
  }
  return 0;
};

// The status Claude Code's status line gets (lightcode.StatusFields): the context of the latest
// main-thread request over the window a result reports, the cache's requests, misses and warmth,
// the rate limits, cost, tokens, lines changed.

export class Status {
  f: Partial<lightcode.StatusFields> = {};
  /** Rate limits seen (else the ones kept from the last run stand). */
  limits = false;
  private messages = new Set<string>();

  private add(key: keyof lightcode.StatusFields, n: number): void {
    (this.f as Record<string, number>)[key] = ((this.f[key] as number | undefined) ?? 0) + n;
  }

  apply(r: Rec, when: number): void {
    const f = this.f;
    if (when > 0 && (f.startMs ?? 0) === 0) f.startMs = when;
    const type = str(r.type);
    if (type === "system") {
      const sub = str(r.subtype);
      if (sub === "init") {
        if (str(r.session_id).length > 0) f.sessionId = str(r.session_id);
        if (str(r.model).length > 0) f.modelId = str(r.model);
        if (str(r.cwd).length > 0) f.cwd = str(r.cwd);
        if (typeof r.claude_code_version === "string") f.version = r.claude_code_version;
      }
      if ((sub === "init" || sub === "status") && str(r.permissionMode).length > 0) f.mode = str(r.permissionMode);
      if (sub === "compact_boundary") {
        // A compaction leaves the context at its summary's size until the next reply says otherwise.
        const meta = rec(r.compact_metadata !== undefined ? r.compact_metadata : r.compactMetadata);
        const post = meta === null ? -1 : typeof meta.post_tokens === "number" ? meta.post_tokens : typeof meta.postTokens === "number" ? meta.postTokens : -1;
        if (post >= 0) {
          f.contextInput = post;
          f.contextCacheRead = 0;
          f.contextCacheWrite = 0;
        }
      }
    } else if (type === "assistant") {
      const msg = rec(r.message);
      if (msg === null) return;
      // The model the main thread runs on: a transcript names it without the "[1m]" an init carries.
      const model = str(msg.model);
      if (model.length > 0 && !model.startsWith("<") && str(r.parent_tool_use_id).length === 0 && model !== (f.modelId ?? "").replace("[1m]", "")) f.modelId = model;
      const id = str(msg.id);
      if (id.length === 0 || this.messages.has(id)) return;
      this.messages.add(id);
      while (this.messages.size > MESSAGES_MAX) {
        const oldest = this.messages.values().next();
        if (oldest.done === true) break;
        this.messages.delete(oldest.value);
      }
      const usage = rec(msg.usage);
      if (usage === null) return;
      const input = num(usage.input_tokens);
      const read = num(usage.cache_read_input_tokens);
      const write = num(usage.cache_creation_input_tokens);
      this.add("totalInput", input + read + write);
      this.add("totalOutput", num(usage.output_tokens));
      this.add("thinking", num(rec(usage.output_tokens_details)?.thinking_tokens));
      // The context and the cache follow the main conversation: a subagent starts a context of its own.
      if (str(r.parent_tool_use_id).length > 0) return;
      this.add("requests", 1);
      if ((f.requests ?? 0) > 1 && read === 0) this.add("misses", 1);
      this.add("cacheRead", read);
      this.add("allInput", input + read + write);
      const creation = rec(usage.cache_creation);
      if (creation !== null && num(creation.ephemeral_1h_input_tokens) > 0) f.cacheTtlMs = 3600000;
      else if ((f.cacheTtlMs ?? 0) === 0 && (read > 0 || write > 0)) f.cacheTtlMs = 300000;
      if (when > 0) f.lastRequestMs = when;
      f.contextInput = input;
      f.contextCacheRead = read;
      f.contextCacheWrite = write;
      f.contextOutput = num(usage.output_tokens);
    } else if (type === "user") {
      const data = rec(r.tool_use_result !== undefined ? r.tool_use_result : r.toolUseResult);
      if (data === null) return;
      for (const h of list(data.structuredPatch))
        for (const l of list(rec(h)?.lines))
          if (typeof l === "string") {
            if (l.startsWith("+")) this.add("linesAdded", 1);
            else if (l.startsWith("-")) this.add("linesRemoved", 1);
          }
    } else if (type === "result") {
      this.add("thinking", num(rec(rec(r.usage)?.output_tokens_details)?.thinking_tokens));
      this.add("apiMs", num(r.duration_api_ms));
      const models = rec(r.modelUsage);
      if (models === null) return;
      // The window of the model the session runs on; without a match, the largest reported.
      let size = 0;
      for (const key of Object.keys(models)) {
        const window = num(rec(models[key])?.contextWindow);
        if (key === (f.modelId ?? "").replace("[1m]", "")) {
          size = window;
          break;
        }
        if (window > size) size = window;
      }
      if (size > 0) f.contextSize = size;
    } else if (type === "rate_limit_event") {
      const windows = rec(rec(r.rate_limit_info)?.unifiedWindows);
      if (windows === null) return;
      const five = rec(windows.five_hour);
      const week = rec(windows.seven_day);
      if (five !== null) {
        f.fiveHourPct = num(five.utilization) * 100;
        f.fiveHourResets = num(five.resetsAt);
      }
      if (week !== null) {
        f.weekPct = num(week.utilization) * 100;
        f.weekResets = num(week.resetsAt);
      }
      this.limits = true;
    } else if (type === "cost-state") {
      this.add("costUsd", num(r.totalCostUSD));
      if (typeof r.startTime === "number" && ((f.startMs ?? 0) === 0 || r.startTime < (f.startMs ?? 0))) f.startMs = r.startTime;
    }
  }
}
