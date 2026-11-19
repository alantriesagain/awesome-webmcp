// The core side of a plugin's `__host` calls: the direct calls a plugin makes (hooks, timers,
// tells, folder actions, tools) and the namespace dispatch into `src/api`.
import { HostAnswer } from "@lightstart/plugins/engine.ts";
import { errorMessage } from "@lightstart/lib/json.ts";
import { log } from "@lightstart/lib/log.ts";
import type { JsRuntime } from "./runtime.ts";
import { API_ANSWERS } from "./namespaces.ts";
import { answer, json, num, refuse, str, strs } from "../api/values.ts";
import { openFolder, quit } from "../host/actions.ts";

/** Calls whose first argument names the plugin that owns what they add. */
const OWNER_FIRST = [
  "ui.panel",
  "ui.band",
  "ui.segment",
  "ui.refresh",
  "ui.reveal",
  "keys.action",
  "keys.layer",
  "keys.keymap",
  "commands.add",
  "tools.add",
  "agents.register",
  "process.spawn",
  "conversation.ask",
  "conversation.apply",
];

/** How many times a listener's own run may fire its hook again before the rest are dropped. */
const RERUN_MAX = 8;

/** A hook listener that does not run nested: a fire during its own run waits for it, payload-less fires coalesce, and one outer call re-runs it at most `RERUN_MAX` times. */
class HookListener {
  private readonly rt: JsRuntime;
  private readonly owner: string;
  private readonly name: string;
  private readonly fn: number;
  private running = false;
  private queue: unknown[] = [];
  private queuedEmpty = false;

  constructor(rt: JsRuntime, owner: string, name: string, fn: number) {
    this.rt = rt;
    this.owner = owner;
    this.name = name;
    this.fn = fn;
  }

  fire(value?: unknown): void {
    if (this.running) {
      if (value === undefined) {
        if (this.queuedEmpty) return;
        this.queuedEmpty = true;
      }
      this.queue.push(value);
      return;
    }
    this.running = true;
    try {
      let reruns = 0;
      let dropped = 0;
      this.run(value);
      while (this.queue.length > 0 && this.rt.host.kernel.has(this.owner)) {
        const next = this.queue.shift();
        if (next === undefined) this.queuedEmpty = false;
        if (reruns >= RERUN_MAX) {
          dropped++;
          continue;
        }
        reruns++;
        this.run(next);
      }
      if (dropped > 0) log("plugins: " + this.owner + ": dropped " + String(dropped) + " re-entrant \"" + this.name + "\" fires past " + String(RERUN_MAX) + " re-runs");
    } finally {
      this.running = false;
    }
  }

  private run(value: unknown): void {
    this.rt.invoke(this.owner, this.fn, value === undefined ? "[]" : "[" + json(value) + "]");
  }
}

/** A call's arguments for the log: its length, and its first and last 200 characters. */
export function argsExcerpt(args: string): string {
  if (args.length === 0) return "an empty string";
  const head = String(args.length) + " characters: ";
  if (args.length <= 400) return head + JSON.stringify(args);
  return head + JSON.stringify(args.slice(0, 200)) + " … " + JSON.stringify(args.slice(args.length - 200));
}

export class HostRouter {
  readonly rt: JsRuntime;

  constructor(rt: JsRuntime) {
    this.rt = rt;
  }

  answer(name: string, argsJson: string): HostAnswer {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(argsJson);
    } catch {
      log("plugins: " + name + ": arguments that are not JSON, " + argsExcerpt(argsJson));
      return refuse("widecode: arguments that are not JSON");
    }
    const a: unknown[] = Array.isArray(parsed) ? (parsed as unknown[]) : [];
    // The api appends its registration; a direct __host call has none.
    let token = "";
    const last = a.length > 0 ? a[a.length - 1] : null;
    if (typeof last === "string" && last.startsWith("@r")) {
      token = last;
      a.pop();
    }
    if (this.rt.callingReg > 0 && name !== "plugin" && token !== "@r" + String(this.rt.callingReg)) return refuse("widecode: this call did not come through the plugin's api");
    if (this.rt.callingReg > 0 && OWNER_FIRST.includes(name) && str(a[0]) !== this.rt.callingOwner) return refuse("widecode: " + name + " names another plugin");
    const h = this.rt.host;
    switch (name) {
      case "plugin":
        return this.rt.register(str(a[0]), strs(a[1]), a[2], num(a[3]), num(a[4]), str(a[5]), num(a[6]));
      case "on": {
        const owner = str(a[0]);
        const name = str(a[1]);
        const hook = h.hook(name);
        const fn = num(a[2]);
        if (hook === null) return refuse("no hook named " + name);
        const listener = new HookListener(this.rt, owner, name, fn);
        hook.on((value: unknown) => listener.fire(value), owner);
        return answer(null);
      }
      case "tell":
        h.screen.tell(str(a[0]));
        return answer(null);
      case "note":
        h.note(str(a[0]));
        return answer(null);
      case "every":
        this.rt.every(str(a[0]), num(a[1]), num(a[2]));
        return answer(null);
      case "after": {
        const owner = str(a[0]);
        const fn = num(a[2]);
        const l = this.rt.life(owner);
        setTimeout(() => {
          if (this.rt.alive(l)) this.rt.invoke(owner, fn, "[]");
        }, Math.max(0, num(a[1]))).unref();
        return answer(null);
      }
      case "relative":
        return answer(h.folder.relative(str(a[0])));
      case "focus":
        h.screen.focus(str(a[0]));
        return answer(null);
      case "showPanel":
        h.screen.showPanel(str(a[0]));
        return answer(null);
      case "quit":
        quit();
        return answer(null);
      case "openFolder":
        void openFolder(str(a[0])).catch((err: unknown) => {
          h.screen.tell("cannot open " + str(a[0]) + ": " + errorMessage(err, "error"));
        });
        return answer(null);
      case "loadFiles":
        this.rt.settle(str(a[0]), num(a[1]), h.folder.loadFiles().then(() => "null"));
        return answer(null);
      case "loadStatus":
        this.rt.settle(str(a[0]), num(a[1]), h.folder.loadStatus().then(() => "null"));
        return answer(null);
      case "setBase":
        h.folder.setBase(str(a[0]), str(a[1]), str(a[2]));
        return answer(null);
      case "toolDone":
        // A plugin's tool answered call `a[0]`: its text, an error or not.
        this.rt.forgetToolCancel(num(a[0]));
        this.rt.mcp.answer(num(a[0]), str(a[1]), a[2] === true);
        return answer(null);
    }
    // A call of a namespace, answered by its file (src/api/<namespace>.ts).
    const ns = name.slice(0, Math.max(0, name.indexOf(".")));
    for (const group of API_ANSWERS) {
      if (!group.names.includes(ns)) continue;
      const answered = group.answer(this.rt, name, a);
      if (answered !== null) return answered;
    }
    return refuse("widecode has no call named " + name);
  }
}
