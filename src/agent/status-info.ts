// What the status bar shows: the agent fills it (an `info` event, conversation/events.ts) and the app
// adds what it knows. The fields follow Claude Code's status line input
// (https://code.claude.com/docs/en/statusline.md), so `json()` is what a Claude Code status line
// script expects on stdin, with widecode's extras under "widecode": tool counts, calls, the running
// tool. Claude Code's adapter (plugins/claude/index.ts) fills it from its records:
//   context  the latest main-thread request's input (prompt + cache read + cache written) over the
//            window the result reports (before one: the window stored for the session, else 1M
//            when the model or the alias widecode started it with carries "[1m]", else 200k)
//   model    the init's; before one (a resumed session) the main thread's last assistant message's
//   cache    per request (an assistant message, counted once): hits, misses (a request after the
//            first that read nothing from the cache), warm while younger than its TTL (1h when it
//            wrote to the 1-hour cache, else 5 minutes)
//   limits   the rate_limit_event windows, five hours and seven days

import { modelName } from "./model-name.ts";

export { modelName };

export class StatusInfo {
  sessionId = "";
  title = "";
  transcriptPath = "";
  cwd = "";
  branch = "";
  version = "";
  modelId = "";
  /** The model alias widecode starts the CLI with ("opus[1m]"; "" for the CLI's default). */
  modelHint = "";
  /** The window stored for the session from an earlier process (0: none). */
  knownWindow = 0;
  effort = "";
  /** The CLI's permission mode ("bypassPermissions", "plan", …). */
  mode = "";
  contextInput = 0;
  contextOutput = 0;
  contextCacheRead = 0;
  contextCacheWrite = 0;
  contextSize = 0;
  totalInput = 0;
  totalOutput = 0;
  fiveHourPct = -1;
  fiveHourResets = 0;
  weekPct = -1;
  weekResets = 0;
  requests = 0;
  misses = 0;
  cacheRead = 0;
  allInput = 0;
  cacheTtlMs = 0;
  lastRequestMs = 0;
  costUsd = 0;
  startMs = 0;
  apiMs = 0;
  linesAdded = 0;
  linesRemoved = 0;
  reads = 0;
  writes = 0;
  execs = 0;
  agents = 0;
  calls = 0;
  thinking = 0;
  /** The running tool and what it does ("" when none), when the step it is on began (0: none), and messages queued; set by the app. */
  activity = "";
  activitySince = 0;
  queued = 0;

  get contextUsed(): number {
    return this.contextInput + this.contextCacheRead + this.contextCacheWrite;
  }

  get windowSize(): number {
    if (this.contextSize > 0) return this.contextSize;
    if (this.knownWindow > 0) return this.knownWindow;
    return this.modelId.includes("[1m]") || this.modelHint.includes("[1m]") ? 1000000 : 200000;
  }

  /** The model's name for the status bar: "Opus 5.5 1M", or the alias's before the CLI said. */
  get modelLabel(): string {
    if (this.modelId.length === 0) return this.modelHint.length > 0 ? modelName(this.modelHint) : "";
    const name = modelName(this.modelId);
    return this.windowSize >= 1000000 && !name.endsWith(" 1M") ? name + " 1M" : name;
  }

  /** Whether the prompt cache is still warm at `now`. */
  warm(now: number): boolean {
    return this.cacheTtlMs > 0 && this.lastRequestMs > 0 && now - this.lastRequestMs < this.cacheTtlMs;
  }

  hitRatio(): number {
    return this.allInput > 0 ? this.cacheRead / this.allInput : 0;
  }

  /** Claude Code's status line input (plus "widecode"), as JSON text. */
  json(now: number): string {
    const size = this.windowSize;
    const used = size > 0 ? Math.round((this.contextUsed / size) * 100) : 0;
    const expires = this.lastRequestMs > 0 && this.cacheTtlMs > 0 ? Math.round((this.lastRequestMs + this.cacheTtlMs) / 1000) : 0;
    const v: unknown = {
      cwd: this.cwd,
      session_id: this.sessionId,
      session_name: this.title,
      transcript_path: this.transcriptPath,
      model: { id: this.modelId, display_name: this.modelLabel },
      workspace: { current_dir: this.cwd, project_dir: this.cwd, added_dirs: [] },
      version: this.version,
      output_style: { name: "default" },
      cost: { total_cost_usd: this.costUsd, total_duration_ms: this.startMs > 0 ? now - this.startMs : 0, total_api_duration_ms: this.apiMs, total_lines_added: this.linesAdded, total_lines_removed: this.linesRemoved },
      context_window: {
        total_input_tokens: this.totalInput,
        total_output_tokens: this.totalOutput,
        context_window_size: size,
        used_percentage: used,
        remaining_percentage: 100 - used,
        current_usage: { input_tokens: this.contextInput, output_tokens: this.contextOutput, cache_creation_input_tokens: this.contextCacheWrite, cache_read_input_tokens: this.contextCacheRead },
      },
      exceeds_200k_tokens: this.contextUsed > 200000,
      prompt_cache: { warm: this.warm(now), caching_observed: this.cacheTtlMs > 0, ttl: this.cacheTtlMs >= 3600000 ? "1h" : "5m", expires_at: expires, requests: this.requests, misses: this.misses, hit_ratio: Math.round(this.hitRatio() * 100) / 100 },
      effort: { level: this.effort },
      rate_limits: { five_hour: { used_percentage: this.fiveHourPct, resets_at: this.fiveHourResets }, seven_day: { used_percentage: this.weekPct, resets_at: this.weekResets } },
      widecode: { branch: this.branch, mode: this.mode, activity: this.activity, activity_ms: this.activitySince > 0 ? Math.max(0, now - this.activitySince) : -1, queued: this.queued, reads: this.reads, writes: this.writes, execs: this.execs, agents: this.agents, calls: this.calls, thinking_tokens: this.thinking },
    };
    return JSON.stringify(v);
  }
}
