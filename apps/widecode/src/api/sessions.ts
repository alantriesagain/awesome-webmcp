// The plugin API's `sessions`, `store` and `titles` calls, answered for the runtime (runtime.ts
// dispatches by namespace): the folder's sessions with the agent, widecode's records of them, and
// the titles Claude writes for Claude Code's.
import { PreludePart } from "@light/plugins/prelude.ts";
import type { JsRuntime } from "../runtime/runtime.ts";
import { HostAnswer } from "@light/plugins/engine.ts";
import { Limits } from "@widecode/conversation/session-store.ts";
import type { ListedSession } from "./values.ts";
import { SkillRunRow } from "../services/sessions.ts";
import { str, num, list, json, answer, answerText, objectText } from "./values.ts";

/** A session record's fields as a plugin passes them, every one `unknown`. */
interface SessionFields {
  title?: unknown;
  titleBy?: unknown;
  baseCommit?: unknown;
  file?: unknown;
  costUsd?: unknown;
  thinkingTokens?: unknown;
  model?: unknown;
  effort?: unknown;
  contextWindow?: unknown;
}

/** A skill run as a plugin passes it, every field `unknown`. */
interface SkillRunFields {
  skill?: unknown;
  callId?: unknown;
  state?: unknown;
  startedMs?: unknown;
  endedMs?: unknown;
  calls?: unknown;
}

/** Plugin call `name` with its arguments `a`, answered; null for a call of another namespace. */
export const answerSessions = (rt: JsRuntime, name: string, a: unknown[]): HostAnswer | null => {
  const h = rt.host;
  switch (name) {
    case "sessions.list": {
      // The folder's sessions with the agent, newest first, as its plugin lists them, each with the
      // title widecode keeps for it.
      const out: string[] = [];
      const records = h.session.records;
      const folder = h.workspace.folder;
      const listed = (s: ListedSession): void => {
        const id = str(s.id);
        const meta = records !== null ? records.session(id, folder) : null;
        out.push(
          objectText(
            ["id", "agentTitle", "firstPrompt", "lastPrompt", "cwd", "model", "mtimeMs", "size", "storedTitle", "titleBy"],
            [json(id), json(str(s.title)), json(str(s.firstPrompt)), json(str(s.lastPrompt)), json(str(s.cwd)), json(str(s.model)), String(Math.max(0, num(s.mtimeMs))), String(Math.max(0, num(s.size))), json(meta !== null ? meta.title : ""), json(meta !== null ? meta.titleBy : "")],
          ),
        );
      };
      const agent = rt.chosenAgent();
      if (agent !== null) {
        for (const v of list(JSON.parse(agent.sessions(folder)) as unknown)) {
          const s = v !== null && typeof v === "object" && !Array.isArray(v) ? (v as ListedSession) : null;
          if (s !== null && str(s.id).length > 0) listed(s);
        }
      }
      return answerText("[" + out.join(",") + "]");
    }
    case "sessions.rev": {
      const agent = rt.chosenAgent();
      return answer(agent !== null ? agent.sessionsRev : 0);
    }
    case "store.session": {
      const meta = h.session.records !== null ? h.session.records.session(str(a[0]), h.workspace.folder) : null;
      if (meta === null) return answer(null);
      return answerText(
        objectText(
          ["title", "titleBy", "baseCommit", "file", "costUsd", "thinkingTokens", "model", "effort", "contextWindow", "agent"],
          [json(meta.title), json(meta.titleBy), json(meta.baseCommit), json(meta.file), String(meta.costUsd), String(meta.thinkingTokens), json(meta.model), json(meta.effort), String(meta.contextWindow), json(meta.agent)],
        ),
      );
    }
    case "store.updateSession": {
      const store = h.session.records;
      const id = str(a[0]);
      const fields = a[1] !== null && typeof a[1] === "object" && !Array.isArray(a[1]) ? (a[1] as SessionFields) : null;
      if (store === null || id.length === 0 || fields === null) return answer(false);
      const meta = store.sessionOrNew(id, h.workspace.folder);
      if (typeof fields.title === "string") meta.title = fields.title;
      if (typeof fields.titleBy === "string") meta.titleBy = fields.titleBy;
      if (typeof fields.baseCommit === "string") meta.baseCommit = fields.baseCommit;
      if (typeof fields.file === "string") meta.file = fields.file;
      if (typeof fields.costUsd === "number") meta.costUsd = fields.costUsd;
      if (typeof fields.thinkingTokens === "number") meta.thinkingTokens = fields.thinkingTokens;
      if (typeof fields.model === "string") meta.model = fields.model;
      if (typeof fields.effort === "string") meta.effort = fields.effort;
      if (typeof fields.contextWindow === "number") meta.contextWindow = fields.contextWindow;
      // The record is the chosen agent's: what it lists, runs or titles.
      meta.agent = h.conversation.agent.id();
      store.saveSession(meta);
      return answer(true);
    }
    case "store.saveSkillRun": {
      // A skill run that ended, kept in the folder by its session and its call (or a typed one's start).
      const records = h.session.records;
      const r = a[0] !== null && typeof a[0] === "object" && !Array.isArray(a[0]) ? (a[0] as SkillRunFields) : null;
      const session = h.conversation.sessionId;
      if (records === null || r === null || str(r.skill).length === 0 || session.length === 0) return answer(false);
      const row = new SkillRunRow();
      const callId = str(r.callId);
      row.id = session + ":" + (callId.length > 0 ? callId : "typed:" + String(Math.max(0, num(r.startedMs))));
      row.session = session;
      row.agent = h.conversation.agent.id();
      row.skill = str(r.skill);
      row.typed = callId.length === 0;
      row.state = str(r.state);
      row.startedMs = Math.max(0, num(r.startedMs));
      row.endedMs = Math.max(0, num(r.endedMs));
      row.calls = Math.max(0, num(r.calls));
      records.saveSkillRun(row);
      return answer(true);
    }
    case "store.skillUsage": {
      const records = h.session.records;
      const out: string[] = [];
      if (records !== null)
        for (const u of records.skillUsage())
          out.push(objectText(["name", "runs", "typed", "failed", "lastMs"], [json(u.name), String(u.runs), String(u.typed), String(u.failed), String(u.lastMs)]));
      return answerText("[" + out.join(",") + "]");
    }
    case "store.taskTranscript": {
      // A Task run's steps kept under the project, for a session reading them back.
      const store = h.session.store;
      return answer(store !== null ? store.taskTranscript(h.workspace.folder, str(a[0]), str(a[1])) : "");
    }
    case "store.saveTaskTranscript": {
      const store = h.session.store;
      return answer(store !== null && store.saveTaskTranscript(h.workspace.folder, str(a[0]), str(a[1]), str(a[2])));
    }
    case "store.saveLimits": {
      // The account's rate limits as the agent last reported them, read by the next run's status.
      const store = h.session.store;
      if (store === null) return answer(false);
      const l = new Limits();
      l.fiveHour.usedPercent = num(a[0]);
      l.fiveHour.resetsAt = Math.max(0, num(a[1]));
      l.sevenDay.usedPercent = num(a[2]);
      l.sevenDay.resetsAt = Math.max(0, num(a[3]));
      l.updatedMs = Date.now();
      const agent = h.conversation.agent.id();
      store.saveLimits(l, agent.length > 0 ? agent : "claude");
      return answer(true);
    }
    case "titles.configure":
      h.session.titler.enabled = a[0] === true;
      if (str(a[1]).length > 0) h.session.titler.model = str(a[1]);
      h.session.titler.onNote = (text: string) => h.note(text);
      return answer(null);
    case "titles.request":
      // Claude writes titles for Claude Code's sessions; another agent's keep their own.
      if (h.conversation.agent.id() !== "claude") return answer(false);
      return answer(h.session.titler.request(str(a[0]), str(a[1]), str(a[2]), a[3] === true));
    case "titles.onTitle": {
      const owner = str(a[0]);
      const fn = num(a[1]);
      const l = rt.life(owner);
      h.session.titler.onTitle = (id: string, title: string) => {
        if (rt.alive(l)) rt.invoke(owner, fn, JSON.stringify([id, title]));
      };
      return answer(null);
    }
  }
  return null;
};

/** The `sessions` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_SESSIONS = new PreludePart("sessions", `        list: () => call("sessions.list"),
        rev: () => call("sessions.rev"),
`);

/** The `store` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_STORE = new PreludePart("store", `        session: (sid) => call("store.session", String(sid)),
        updateSession: (sid, fields) => call("store.updateSession", String(sid), fields),
        saveSkillRun: (r) => call("store.saveSkillRun", { skill: String(r.skill ?? ""), callId: String(r.callId ?? ""), state: String(r.state ?? ""), startedMs: Number(r.startedMs ?? 0), endedMs: Number(r.endedMs ?? 0), calls: Number(r.calls ?? 0) }),
        skillUsage: () => call("store.skillUsage"),
        taskTranscript: (session, callId) => call("store.taskTranscript", String(session), String(callId)),
        saveTaskTranscript: (session, callId, text) => call("store.saveTaskTranscript", String(session), String(callId), String(text)),
        saveLimits: (l) => call("store.saveLimits", Number(l.fiveHourPct ?? -1), Number(l.fiveHourResets ?? 0), Number(l.weekPct ?? -1), Number(l.weekResets ?? 0)),
`);

/** The `titles` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_TITLES = new PreludePart("titles", `        configure: (enabled, model) => call("titles.configure", enabled === true, String(model ?? "")),
        request: (sid, prompt, reply, again) => call("titles.request", String(sid), String(prompt ?? ""), String(reply ?? ""), again === true),
        onTitle: (f) => call("titles.onTitle", id, fn((sid, title) => { f(sid, title); })),
`);
