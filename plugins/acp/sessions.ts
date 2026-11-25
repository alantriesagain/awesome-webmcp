// An agent's sessions: a side question's prompt, the listing read from session/list or the entry's
// command, and the record of sessions made and left, with their forget commands.

import { obj, str, list } from "./json.ts";
import { resolved } from "./agents.ts";
import type { Entry } from "./agents.ts";
import { quote } from "./shell.ts";

/** What a side question's fork is told before the question. */
export const SIDE_PROMPT = "Answer briefly, from what you know of this session so far and without tools:\n\n";

/** How long a listing of sessions is used before it is read again. */
export const LISTING_MS = 3000;

/** A time as epoch ms: a number (seconds when it is small) or a date's text. */
const msOf = (v: unknown): number => {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
};

/** Sessions as an agent lists them (session/list's, or its command's JSON), those of `folder`, newest first. */
export const sessionsOf = (v: unknown, folder: string): lightcode.AgentSession[] => {
  const out: lightcode.AgentSession[] = [];
  for (const x of list(v)) {
    const s = obj(x);
    if (s === null) continue;
    const id = str(s.sessionId) || str(s.id);
    const dir = str(s.cwd) || str(s.directory);
    if (id.length === 0 || (dir.length > 0 && dir !== folder)) continue;
    const time = obj(s.time);
    out.push({ id, title: str(s.title) || str(s.name), mtimeMs: msOf(s.updatedAt ?? s.updated ?? time?.updated ?? s.mtime) });
  }
  return out.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
};

/** A session made and not written to yet (the agent keeps it as any other): whose agent, its id, the lightcode process that made it, its folder; kept in the plugin's state until it is deleted. */
interface Fresh {
  agent: string;
  id: string;
  pid: number;
  folder: string;
}

const freshOf = (api: lightcode.Api): Fresh[] => {
  const out: Fresh[] = [];
  const kept = obj(api.settings.state());
  for (const x of list(kept?.fresh)) {
    const f = obj(x);
    if (f !== null && str(f.agent).length > 0 && str(f.id).length > 0) out.push({ agent: str(f.agent), id: str(f.id), pid: typeof f.pid === "number" ? f.pid : 0, folder: str(f.folder) });
  }
  return out;
};

export const rememberFresh = (api: lightcode.Api, f: Fresh): void => api.settings.setState({ fresh: [...freshOf(api).filter((k) => k.id !== f.id), f] });

export const dropFresh = (api: lightcode.Api, sid: string): void => api.settings.setState({ fresh: freshOf(api).filter((k) => k.id !== sid) });

/** This process's id (Linux), 0 when unknown; whether process `pid` runs. */
export const ownPid = (api: lightcode.Api): number => parseInt((api.fs.text("/proc/self/stat") ?? "").split(" ")[0], 10) || 0;
const alive = (api: lightcode.Api, pid: number): boolean => pid > 0 && api.fs.stat("/proc/" + String(pid)) !== null;

/** Delete session `sid` of `entry` with its forget command, run in `folder`, the outcome noted as `what`. */
export const deleteSession = (api: lightcode.Api, entry: Entry, folder: string, sid: string, what: string): void => {
  if (entry.forget.length === 0) return;
  const words = resolved(api, entry.forget).map((w) => w.split("{session}").join(sid));
  api.process.run("cd " + quote(folder) + " && " + words.map(quote).join(" "), "", 15000).then(
    (r) => api.note(entry.name + ": " + (r.code === 0 ? "deleted " + what + " " + sid : "could not delete " + what + " " + sid + ": " + (r.timedOut ? "timed out" : r.err.trim()))),
    (e) => api.note(entry.name + ": could not delete " + what + " " + sid + ": " + String(e)),
  );
};

/** The sessions made and left (their lightcode process gone, or this one, which made them before it started over), but `except`, forgotten and deleted; one of an agent no longer in the section is forgotten. */
export const sweep = (api: lightcode.Api, agents: Record<string, Entry>, except: string): void => {
  const own = ownPid(api);
  for (const f of freshOf(api)) {
    const entry = agents[f.agent];
    if (f.id === except) continue;
    if (entry === undefined || entry.forget.length === 0 || f.pid === own || !alive(api, f.pid)) dropFresh(api, f.id);
    if (entry !== undefined && entry.forget.length > 0 && (f.pid === own || !alive(api, f.pid))) deleteSession(api, entry, f.folder, f.id, "unused session");
  }
};
