// The plugin API's `agent`, `agents` and `conversation` calls, answered for the runtime
// (runtime.ts dispatches by namespace): the conversation with the agent (what the user does, its
// model, effort, mode and session), the agents plugins bring, the events they apply, and the
// requests widecode's own tools put to the user.
import { PreludePart } from "@lightstart/plugins/prelude.ts";
import type { JsRuntime } from "../runtime/runtime.ts";
import { Option } from "../conversation/agent.ts";
import { programCounts } from "../conversation/command.ts";
import { agentDescription, agentStatus, agentType, agentsOf } from "../conversation/agents.ts";
import { skillRuns } from "../conversation/skills.ts";
import { applyEvents, applySubagentEvents } from "../conversation/events.ts";
import { Ask } from "../conversation/requests.ts";
import { attachImages } from "../conversation/attach.ts";
import { FNS, JsAgent } from "../runtime/agent.ts";
import { HostAnswer } from "@lightstart/plugins/engine.ts";
import { str, num, list, json, answer, answerText, objectText, listText } from "./values.ts";
import { trail } from "@lightstart/lib/log.ts";
import { deliverAgentPart } from "./agent-part.ts";

/** Plugin call `name` with its arguments `a`, answered; null for a call of another namespace. */
export const answerAgent = (rt: JsRuntime, name: string, a: unknown[]): HostAnswer | null => {
  const h = rt.host;
  switch (name) {
    case "agents.register": {
      // An agent plugin `owner` brings: its functions play the conversation's agent when it is chosen.
      const owner = str(a[0]);
      const fns: number[] = [];
      if (Array.isArray(a[4])) for (const f of a[4] as unknown[]) fns.push(num(f));
      while (fns.length < FNS) fns.push(-1);
      const agent = new JsAgent(rt, owner, str(a[1]), str(a[2]), fns);
      agent.offer(a[3]);
      agent.eager = a[5] === true;
      agent.onSystemPrompt = () => h.harness.systemPrompt(rt.mcp.visibleNames(owner));
      agent.onPermissions = () => h.session.permissions().rulesJson();
      rt.agents.push(agent);
      h.session.addAgent(owner, agent);
      return answer(null);
    }
    case "conversation.apply": {
      // Events from plugin `owner`'s agent while the conversation talks to it (a late line from one
      // it no longer talks to is dropped): applied, and its process's state noted.
      const c = h.conversation;
      if (c.agent.owner !== str(a[0])) return answer(0);
      const events = list(a[1]);
      const first = events.length > 0 ? events[0] : null;
      const at = trail.within("events", typeof first === "object" && first !== null ? str((first as { type?: unknown }).type) : "");
      const n = applyEvents(c.model, c.info, a[1]);
      trail.leave(at);
      const agent = rt.chosenAgent();
      if (agent !== null) agent.sawEvents(a[1]);
      // A turn that ended withdrew the requests of widecode's tools in it.
      c.settleAsks(false);
      if (n > 0) c.changed();
      return answer(n);
    }
    case "conversation.fromAgentPart": {
      // A message from plugin `a[1]`'s agent part to its app part in this session.
      return answer(deliverAgentPart(rt, str(a[1]), str(a[2]), a[3]));
    }
    case "conversation.subagent": {
      // A run under a call of the open turn (or a transcript read back into a closed one): the
      // conversation's model, and its status for the call's own change of kind.
      const n = applySubagentEvents(h.conversation.model, str(a[1]), a[2], a[3] === true, h.conversation.info);
      if (n > 0) h.conversation.changed();
      return answer(n);
    }
    case "conversation.ask": {
      // A request for the user from plugin `owner` (one of widecode's tools): the panel shows it, and the reply settles the plugin's promise.
      const owner = str(a[0]);
      const parent = str(a[2]);
      const fn = num(a[3]);
      const ask = new Ask();
      const reply = new Promise<string>((resolve) => {
        ask.onReplied = (text: string) => resolve(text);
      });
      rt.settle(owner, fn, reply);
      h.conversation.ask(ask, a[1], parent);
      return answer(null);
    }
    case "agent.tools": {
      // The tools the agent has, with the MCP server each comes from, what the mode lets it do and how many calls of it the session holds, and its servers.
      const m = h.conversation.model;
      const counts = m.callCounts();
      const tools: string[] = [];
      for (const t of m.available) tools.push(objectText(["name", "server", "access", "scope", "calls"], [json(t.name), json(t.server), json(t.access), json(t.scope), String(counts.get(t.id) ?? 0)]));
      const servers: string[] = [];
      for (const s of m.servers) servers.push(objectText(["name", "status"], [json(s.name), json(s.status)]));
      // The programs the session's commands ran, most run first.
      const programs: string[] = [];
      for (const p of programCounts(m.commands())) programs.push(objectText(["program", "calls"], [json(p.program), String(p.calls)]));
      return answerText(objectText(["known", "ownKnown", "tools", "servers", "programs"], [json(m.availableKnown), json(m.ownKnown), "[" + tools.join(",") + "]", "[" + servers.join(",") + "]", "[" + programs.join(",") + "]"]));
    }
    case "agent.skills": {
      // The skills the agent has, each with where it comes from, its file and the text that calls it; and the session's skill runs.
      const m = h.conversation.model;
      const skills: string[] = [];
      for (const s of m.skills) skills.push(objectText(["name", "description", "source", "path", "command"], [json(s.name), json(s.description), json(s.source), json(s.path), json(s.command)]));
      const runs: string[] = [];
      for (const r of skillRuns(m)) runs.push(objectText(["name", "callId", "state", "startedMs", "endedMs", "calls"], [json(r.name), json(r.callId), json(r.state), String(r.startedMs), String(r.endedMs), String(r.calls)]));
      return answerText(objectText(["known", "partial", "skills", "runs"], [json(m.skillsKnown), json(m.skillsPartial), "[" + skills.join(",") + "]", "[" + runs.join(",") + "]"]));
    }
    case "agent.agents": {
      // The session's subagents: each call's id, kind, task, where it stands, and what it is doing or said.
      const out: string[] = [];
      for (const item of agentsOf(h.conversation.model)) {
        const task = item.task;
        const result = item.result;
        out.push(
          objectText(
            ["id", "type", "description", "status", "lastTool", "summary", "steps"],
            [json(item.id), json(agentType(item)), json(agentDescription(item)), json(agentStatus(item)), json(task !== null ? task.lastTool : ""), json(task !== null && task.summary.length > 0 ? task.summary : result !== null ? result.text : ""), String(item.children.length)],
          ),
        );
      }
      return answerText("[" + out.join(",") + "]");
    }
    case "agent.info":
      return answerText(objectText(["id", "name"], [json(h.conversation.agent.id()), json(h.conversation.agent.name())]));
    case "agent.choices": {
      // What the agent offers: each list as [{ value, name }].
      const offered = h.conversation.agent.choices();
      const options = (list: Option[]): string => listText(list.map((o: Option) => objectText(["value", "name"], [json(o.value), json(o.name)])));
      return answerText(objectText(["models", "efforts", "modes"], [options(offered.models), options(offered.efforts), options(offered.modes)]));
    }
    case "agent.modelName":
      return answer(h.conversation.modelName);
    case "agent.useModel":
      // The model for the next start, without a switch (a new session's default).
      h.conversation.modelName = str(a[0]);
      h.conversation.info.modelHint = h.conversation.modelHintFor(str(a[0]));
      return answer(null);
    case "agent.setModel":
      h.conversation.setModel(str(a[0]));
      return answer(null);
    case "agent.modelLabel":
      return answer(h.conversation.info.modelLabel);
    case "agent.reportedModel":
      return answer(h.conversation.model.model);
    case "agent.started":
      return answer(h.conversation.started);
    case "agent.running":
      return answer(h.conversation.running);
    case "agent.effort":
      // The effort the agent reports, else the one asked for.
      return answer(h.conversation.model.effort.length > 0 ? h.conversation.model.effort : h.conversation.effort);
    case "agent.setEffort":
      h.conversation.setEffort(str(a[0]));
      return answer(null);
    case "agent.mode":
      return answer(h.conversation.model.permissionMode);
    case "agent.setMode":
      if (!h.session.trusted.peek()) return answer(h.session.untrusted());
      return answer(h.conversation.setMode(str(a[0])));
    case "agent.approval":
      // What asks for permission: "ask", "auto", "plan" or "full".
      return answer(h.approval.approval.value);
    case "agent.setApproval":
      return answer(h.approval.set(str(a[0])));
    case "agent.sideQuestion":
      // A side question (/btw): its answer shows in the chat, kept out of the conversation; "" or why not.
      return answer(h.conversation.sideQuestion(str(a[0])));
    case "agent.interrupt":
      h.conversation.interrupt();
      return answer(null);
    case "agent.send": {
      // A message from the user, or one `options.from` names another sender of (a finished task): the images it names attached; "" or why it was not sent (the folder not trusted, the agent not starting).
      if (!h.session.trusted.peek()) return answerText(objectText(["error", "images"], [json(h.session.untrusted()), "0"]));
      let from = "";
      const options = a[1];
      if (typeof options === "object" && options !== null && !Array.isArray(options)) {
        const named = (options as { from?: unknown }).from;
        if (typeof named === "string") from = named;
      }
      if (from.length === 0) h.session.messageSending.fire();
      const attached = attachImages(str(a[0]), h.workspace.folder);
      if (attached.error.length > 0) return answerText(objectText(["error", "images"], [json(attached.error), "0"]));
      const error = h.conversation.send(attached.text, attached.images, from);
      return answerText(objectText(["error", "images"], [json(error.length > 0 ? "cannot start " + h.conversation.agent.name() + ": " + error : ""), String(attached.images.length)]));
    }
    case "agent.reset":
      // A new session: one that starts at launch starts now (once the folder is trusted).
      h.conversation.reset();
      if (h.session.trusted.peek()) h.conversation.prepare();
      return answer(null);
    case "agent.resume":
      if (!h.session.trusted.peek()) {
        h.screen.tell(h.session.untrusted());
        return answer(null);
      }
      {
        const why = h.session.resumeSession(str(a[0]), str(a[1]));
        if (why.length > 0) h.screen.tell(why);
      }
      return answer(null);
    case "agent.sessionId":
      return answer(h.conversation.sessionId);
    case "agent.title":
      return answer(h.conversation.title);
    case "agent.setTitle":
      h.conversation.title = str(a[0]);
      h.session.conversationChanged.fire();
      return answer(null);
    case "agent.firstExchange": {
      const e = h.conversation.firstExchange();
      return answerText(objectText(["prompt", "reply"], [json(e.prompt), json(e.reply)]));
    }
    case "agent.edits": {
      // Claude's file edits: a counter that moves with each, the last one's path and every path edited, relative to the folder.
      const m = h.conversation.model;
      const edited: string[] = [];
      for (const p of m.edited) {
        const rel = h.folder.relative(p);
        if (rel.length > 0) edited.push(rel);
      }
      return answerText(objectText(["seq", "last", "edited"], [String(m.editSeq), json(h.folder.relative(m.lastEdit)), json(edited)]));
    }
    case "agent.headAtStart":
      return answer(h.conversation.headAtStart);
    case "agent.setHeadAtStart":
      h.conversation.headAtStart = str(a[0]);
      return answer(null);
    case "agent.startMs":
      return answer(h.conversation.info.startMs);
    case "agent.queued":
      return answer(h.conversation.model.pending.length);
  }
  return null;
};

/** The `agents` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_AGENTS = new PreludePart("agents", `        register: (a) => {
          call("agents.register", id, String(a.id), String(a.name ?? a.id), a.choices ?? null, [
            fn((o) => a.start(o) ?? ""),
            fn((text, images, from) => a.send(text, images, from) ?? ""),
            opt(a.interrupt, () => { a.interrupt(); }),
            opt(a.setMode, (mode) => a.setMode(mode) ?? ""),
            opt(a.setModel, (name) => { a.setModel(name); }),
            opt(a.setEffort, (level) => { a.setEffort(level); }),
            opt(a.respond, (request, reply) => { a.respond(request, reply); }),
            opt(a.resume, (sid) => { a.resume(sid); }),
            opt(a.reset, () => { a.reset(); }),
            opt(a.stop, () => { a.stop(); }),
            opt(a.kill, () => { a.kill(); }),
            opt(a.loadEarlier, () => a.loadEarlier() === true),
            opt(a.receive, (line) => { a.receive(line); }),
            opt(a.sessions, (folder) => a.sessions(folder)),
            opt(a.loadSubagent, (callId) => a.loadSubagent(callId) === true),
            opt(a.withdraw, () => a.withdraw() ?? ""),
            opt(a.sideQuestion, (question) => a.sideQuestion(question) ?? ""),
            opt(a.toAgentPart, (plugin, type, data) => a.toAgentPart(plugin, type, data) === true),
          ], a.eager === true);
        },
`);

/** The `conversation` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_CONVERSATION = new PreludePart("conversation", `        apply: (events) => call("conversation.apply", id, Array.isArray(events) ? events : [events]),
        subagent: (callId, events, historical) => call("conversation.subagent", id, String(callId), Array.isArray(events) ? events : [events], historical === true),
        ask: (request, parent) => later("conversation.ask", id, request, String(parent ?? "")),
        fromAgentPart: (plugin, type, data) => call("conversation.fromAgentPart", id, String(plugin), String(type), data === undefined ? null : data),
`);

/** The `agent` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_AGENT = new PreludePart("agent", `        info: () => call("agent.info"),
        choices: () => call("agent.choices"),
        modelName: () => call("agent.modelName"),
        useModel: (name) => call("agent.useModel", String(name)),
        setModel: (name) => call("agent.setModel", String(name)),
        modelLabel: () => call("agent.modelLabel"),
        reportedModel: () => call("agent.reportedModel"),
        started: () => call("agent.started"),
        running: () => call("agent.running"),
        effort: () => call("agent.effort"),
        setEffort: (level) => call("agent.setEffort", String(level)),
        mode: () => call("agent.mode"),
        setMode: (mode) => call("agent.setMode", String(mode)),
        approval: () => call("agent.approval"),
        setApproval: (mode) => call("agent.setApproval", String(mode)),
        interrupt: () => call("agent.interrupt"),
        send: (text, options) => call("agent.send", String(text), options ?? null),
        reset: () => call("agent.reset"),
        resume: (id, title) => call("agent.resume", String(id), String(title ?? "")),
        sessionId: () => call("agent.sessionId"),
        title: () => call("agent.title"),
        setTitle: (title) => call("agent.setTitle", String(title)),
        firstExchange: () => call("agent.firstExchange"),
        edits: () => call("agent.edits"),
        headAtStart: () => call("agent.headAtStart"),
        setHeadAtStart: (sha) => call("agent.setHeadAtStart", String(sha)),
        startMs: () => call("agent.startMs"),
        queued: () => call("agent.queued"),
        agents: () => call("agent.agents"),
        sideQuestion: (question) => call("agent.sideQuestion", String(question)),
        tools: () => call("agent.tools"),
        skills: () => call("agent.skills"),
`);
