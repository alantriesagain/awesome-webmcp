// The plugin API's `agentPart` calls: the messages between a plugin's app part and its agent part in
// the harness, both ways. A listener is kept with the plugin's instance stamp, so one a reload left
// behind is not called; `agentPart.send` hands the data to the chosen agent's adapter, which may
// have no channel for it (then it answers false). The agent's side routes by plugin id, so only the
// plugin's own messages reach it.
import { PreludePart } from "@lightstart/plugins/prelude.ts";
import type { JsRuntime, Life } from "../runtime/runtime.ts";
import { HostAnswer } from "@lightstart/plugins/engine.ts";
import { str, num, json, answer } from "./values.ts";

class PartListener {
  readonly owner: string;
  readonly type: string;
  readonly fn: number;
  readonly token: number;
  readonly life: Life;

  constructor(owner: string, type: string, fn: number, token: number, life: Life) {
    this.owner = owner;
    this.type = type;
    this.fn = fn;
    this.token = token;
    this.life = life;
  }
}

const listeners = new Map<string, PartListener[]>();
let seq = 0;

const keyOf = (owner: string, type: string): string => owner + "\u0000" + type;

const drop = (owner: string, type: string, token: number): void => {
  const key = keyOf(owner, type);
  const list = listeners.get(key);
  if (list === undefined) return;
  const at = list.findIndex((h) => h.token === token);
  if (at >= 0) list.splice(at, 1);
  if (list.length === 0) listeners.delete(key);
};

/** A message from plugin `plugin`'s agent part to its app part: every live listener of `type`. */
export const deliverAgentPart = (rt: JsRuntime, plugin: string, type: string, data: unknown): number => {
  if (plugin.length === 0) return 0;
  const key = keyOf(plugin, type);
  const list = listeners.get(key);
  if (list === undefined) return 0;
  let n = 0;
  for (const h of list.slice()) {
    if (!rt.alive(h.life)) {
      drop(h.owner, h.type, h.token);
      continue;
    }
    rt.invoke(h.owner, h.fn, json([data]));
    n++;
  }
  return n;
};

/** Plugin call `name` with its arguments `a`, answered; null for a call of another namespace. */
export const answerAgentPart = (rt: JsRuntime, name: string, a: unknown[]): HostAnswer | null => {
  switch (name) {
    case "agentPart.on": {
      const owner = str(a[0]);
      const type = str(a[1]);
      const fn = num(a[2]);
      if (fn < 0) {
        drop(owner, type, num(a[3]));
        return answer(null);
      }
      const key = keyOf(owner, type);
      const list = listeners.get(key) ?? [];
      const kept: PartListener[] = [];
      for (const h of list) if (rt.alive(h.life)) kept.push(h);
      const made = new PartListener(owner, type, fn, ++seq, rt.life(owner));
      kept.push(made);
      listeners.set(key, kept);
      return answer(made.token);
    }
    case "agentPart.send": {
      const owner = str(a[0]);
      const type = str(a[1]);
      return answer(rt.host.conversation.agent.toAgentPart(owner, type, a[2]));
    }
  }
  return null;
};

/** The `agentPart` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_AGENT_PART = new PreludePart("agentPart", `        on: (type, f) => {
          if (typeof f !== "function") return () => {};
          const token = call("agentPart.on", id, String(type), fn((data) => { f(data); }));
          return () => { call("agentPart.on", id, String(type), -1, token); };
        },
        send: (type, data) => call("agentPart.send", id, String(type), data === undefined ? null : data),
`);
