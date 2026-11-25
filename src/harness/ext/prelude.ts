// The JS side of the harness's agent API: light's prelude first, for the `lightcode` global a plugin's
// top level reads (its `util` and `theme`), then the harness's own global over it, which records a
// definition's `agent(agent)` part and never runs `activate`. The agent object keeps pi's design under
// lightcode's names: its handlers and tool tables, the answer path for a callback that returns a
// promise (the prelude tells the host the call's id and the settled value or error, and the host
// keeps the turn going meanwhile), and its settings. Mirrors the app runtime's toolCall/toolDone shape.
import { buildPrelude } from "@lightstart/plugins/prelude.ts";

/** The theme a plugin's top level sees: the fields the builder reads, and the names plugins use. */
const HARNESS_THEME = '{"dim":"#666666","ok":"#5fd75f","bad":"#ff5f5f","warn":"#ffd75f","think":"#878787","link":"#5fafff","code":"#c0c0c0","prompt":"#ffffff","selected":"#303030","shown":"#202020","fresh":"#ffffff","band":"#101010","marks":{},"frames":["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"],"tick":80}';

/** A plugin's `agent` part over the engine: evaluated after light's prelude, in the same context. */
const AGENT_RUNTIME: string = `"use strict";
(() => {
  const base = globalThis.__lightcodeBase;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const fns = [];
  let seq = 0;
  let file = "";
  let instance = 0;
  const call = (name, ...args) => parse(__host(name, stringify(args)));
  const fn = (f) => {
    fns.push(f);
    return fns.length - 1;
  };
  const messageOf = (e) => (e !== null && typeof e === "object" && typeof e.message === "string" ? e.message : String(e));
  const waiting = {};
  let hostSeq = 0;
  const hostLater = (name, args) => new Promise((resolve, reject) => {
    const id = ++hostSeq;
    waiting[id] = { resolve, reject };
    __host(name, stringify([id, ...args]));
  });
  const hostSettle = (id, error, value) => {
    const w = waiting[id];
    if (w === undefined) return;
    delete waiting[id];
    if (error === null || error === undefined) w.resolve(value);
    else w.reject(new Error(String(error)));
  };
  const signalOf = (aborted) => {
    const listeners = [];
    const s = {
      aborted: aborted === true,
      addEventListener: (name, f) => {
        if (name === "abort" && typeof f === "function") listeners.push(f);
      },
      removeEventListener: (name, f) => {
        const at = listeners.indexOf(f);
        if (name === "abort" && at >= 0) listeners.splice(at, 1);
      },
      __fire: () => {
        if (s.aborted) return;
        s.aborted = true;
        for (const f of listeners.slice()) f({ type: "abort" });
      },
    };
    return s;
  };
  const ctxOf = (c) => {
    const signal = signalOf(c.aborted);
    const ctxId = c.ctxId;
    const dialog = (method, fields, opts) => {
      const fallback = method === "confirm" ? false : undefined;
      if (c.hasUI !== true) return Promise.resolve(fallback);
      const answer = hostLater("extDialog", [ctxId, method, fields]).then(
        (v) => {
          if (method === "confirm") return v === true;
          return v === null || v === undefined ? undefined : v;
        },
        () => fallback,
      );
      const sig = opts === undefined || opts === null ? undefined : opts.signal;
      if (sig === undefined || sig === null) return answer;
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => {
          if (done) return;
          done = true;
          resolve(v);
        };
        if (sig.aborted === true) {
          finish(fallback);
          return;
        }
        if (typeof sig.addEventListener === "function") sig.addEventListener("abort", () => finish(fallback));
        answer.then((v) => finish(v), () => finish(fallback));
      });
    };
    const withTimeout = (fields, opts) => {
      const t = opts === undefined || opts === null ? undefined : opts.timeout;
      if (typeof t === "number" && t > 0) fields.timeout = t;
      return fields;
    };
    const maybe = (v) => (v === null || v === undefined ? undefined : v);
    const sessionManager = {
      getSessionId: () => parse(__host("extSession", stringify([ctxId, "getSessionId", ""]))),
      getSessionFile: () => maybe(parse(__host("extSession", stringify([ctxId, "getSessionFile", ""])))),
      getCwd: () => parse(__host("extSession", stringify([ctxId, "getCwd", ""]))),
      getSessionName: () => maybe(parse(__host("extSession", stringify([ctxId, "getSessionName", ""])))),
      getLeafId: () => parse(__host("extSession", stringify([ctxId, "getLeafId", ""]))),
      getHeader: () => parse(__host("extSession", stringify([ctxId, "getHeader", ""]))),
      getEntries: () => parse(__host("extSession", stringify([ctxId, "getEntries", ""]))),
      getBranch: () => parse(__host("extSession", stringify([ctxId, "getBranch", ""]))),
      getEntry: (id) => maybe(parse(__host("extSession", stringify([ctxId, "getEntry", String(id)])))),
    };
    return {
    cwd: c.cwd,
    mode: c.mode,
    sessionManager,
    hasUI: c.hasUI === true,
    model: c.model === undefined ? null : c.model,
    signal,
    abort: () => {
      signal.__fire();
      __host("extAbort", stringify([ctxId]));
    },
    isIdle: () => parse(__host("extIsIdle", stringify([ctxId]))),
    getContextUsage: () => parse(__host("extContextUsage", stringify([ctxId]))),
    getSystemPrompt: () => parse(__host("extSystemPrompt", stringify([ctxId]))),
    ui: {
      select: (title, options, opts) => dialog("select", withTimeout({ title: title, options: Array.isArray(options) ? options : [] }, opts), opts),
      input: (title, placeholder, opts) => dialog("input", withTimeout({ title: title, placeholder: placeholder === undefined ? "" : placeholder }, opts), opts),
      editor: (title, prefill) => dialog("editor", { title: title, prefill: prefill === undefined ? "" : prefill }, undefined),
      confirm: (title, message, opts) => dialog("confirm", withTimeout({ title: title, message: message === undefined ? "" : message }, opts), opts),
      notify: (message, type) => {
        __host("extUi", stringify([ctxId, "notify", message, type === undefined ? "" : type]));
      },
      setStatus: (key, text) => {
        __host("extUi", stringify([ctxId, "setStatus", key, text === undefined ? null : text]));
      },
      setWidget: (key, content, options) => {
        const placement = typeof options === "string" ? options : options !== null && typeof options === "object" ? options.placement : undefined;
        const kind = typeof content === "function" ? "function" : Array.isArray(content) ? "lines" : content === undefined ? "clear" : "invalid";
        __host("extUi", stringify([ctxId, "setWidget", key, kind, Array.isArray(content) ? content : [], placement === undefined ? null : placement]));
      },
      setTitle: (title) => {
        __host("extUi", stringify([ctxId, "setTitle", title]));
      },
      setEditorText: (text) => {
        __host("extUi", stringify([ctxId, "set_editor_text", text]));
      },
      pasteToEditor: (text) => {
        __host("extUi", stringify([ctxId, "set_editor_text", text]));
      },
      getEditorText: () => "",
    },
    };
  };
  const handled = (handler) =>
    fn((event, ctx) => {
      const r = handler(event, ctxOf(ctx));
      if (r !== null && typeof r === "object" && typeof r.then === "function") return r.then((v) => ({ result: v === undefined ? null : v, input: event.input }));
      return { result: r === undefined ? null : r, input: event.input };
    });
  // The definitions a file made: its plugin id, its file and its agent part, the latest per id.
  const defs = Object.create(null);
  // A session instance's channels: its plugins' handlers, kept between the agent parts of one instance.
  const channels = Object.create(null);
  const handlersOn = (inst, channel) => {
    const byChannel = channels[inst] || (channels[inst] = Object.create(null));
    return byChannel[channel] || (byChannel[channel] = []);
  };
  const pluginIdOf = (key) => {
    const at = key.indexOf("\\u0000");
    return at < 0 ? key : key.slice(0, at);
  };
  const appHandlers = (inst, id, type) => handlersOn(inst, "app:" + id + ":" + type);
  const agentFor = (key, inst) => ({
    on: (name, handler) => {
      call("extHandler", key, inst, name, handled(handler));
    },
    events: {
      on: (channel, handler) => {
        if (typeof handler !== "function") return () => {};
        const list = handlersOn(inst, String(channel));
        list.push(handler);
        return () => {
          const at = list.indexOf(handler);
          if (at >= 0) list.splice(at, 1);
        };
      },
      emit: (channel, data) => {
        const list = handlersOn(inst, String(channel)).slice();
        for (const f of list) {
          try {
            f(data);
          } catch (e) {
            __host("extLog", stringify([inst, "event " + String(channel), messageOf(e)]));
          }
        }
      },
    },
    app: {
      send: (type, data) => {
        call("extAppSend", key, inst, String(type), data === undefined ? null : data);
      },
      on: (type, handler) => {
        if (typeof handler !== "function") return () => {};
        const list = appHandlers(inst, pluginIdOf(key), String(type));
        list.push(handler);
        return () => {
          const at = list.indexOf(handler);
          if (at >= 0) list.splice(at, 1);
        };
      },
    },
    getAllTools: () => parse(__host("extAllTools", stringify([inst]))),
    getActiveTools: () => parse(__host("extActiveTools", stringify([inst]))),
    setActiveTools: (names) => {
      __host("extSetActiveTools", stringify([inst, Array.isArray(names) ? names.map((n) => String(n)) : []]));
    },
    setModel: (value) => {
      const ok = parse(__host("extSetModel", stringify([inst, String(value)])));
      return Promise.resolve(ok === true);
    },
    getThinkingLevel: () => {
      const v = parse(__host("extThinkingLevel", stringify([inst])));
      return v === null || v === undefined ? "" : String(v);
    },
    setThinkingLevel: (level) => {
      const ok = parse(__host("extSetEffort", stringify([inst, String(level)])));
      return Promise.resolve(ok === true);
    },
    registerTool: (def) => {
      if (def === null || typeof def !== "object" || typeof def.name !== "string" || typeof def.execute !== "function") throw new Error("agent.registerTool: a tool needs a name and execute()");
      const id = fn((toolCallId, params, ctx) => {
        const c = ctxOf(ctx);
        return def.execute(toolCallId, params, c.signal, () => {}, c);
      });
      call("extTool", key, inst, def.name, def.label === undefined ? def.name : String(def.label), def.description === undefined ? "" : String(def.description), def.parameters === undefined ? { type: "object" } : def.parameters, id);
    },
    registerCommand: (name, def) => {
      if (typeof name !== "string" || def === null || typeof def !== "object" || typeof def.handler !== "function") throw new Error("agent.registerCommand: a command needs a name and handler()");
      const id = fn((args, ctx) => def.handler(args, ctxOf(ctx)));
      call("extCommand", key, inst, name, def.description === undefined ? "" : String(def.description), id);
    },
    appendEntry: (customType, data) => {
      call("extAppendEntry", key, inst, String(customType), data === undefined ? null : data);
    },
    setSessionName: (name) => {
      call("extSetSessionName", key, inst, String(name));
    },
    getSessionName: () => {
      const v = parse(__host("extGetSessionName", stringify([key, inst])));
      return v === null || v === undefined ? undefined : v;
    },
    settings: () => {
      const v = parse(__host("extSettings", stringify([key])));
      return v === null || v === undefined ? {} : v;
    },
    sendUserMessage: (content, options) => {
      call("extSendUserMessage", key, inst, content, options === undefined ? null : options);
    },
    sendMessage: (message, options) => {
      call("extSendMessage", key, inst, message, options === undefined ? null : options);
    },
    exec: (command, args, options) => {
      const o = options === null || typeof options !== "object" ? {} : options;
      const opts = {
        cwd: typeof o.cwd === "string" ? o.cwd : "",
        timeout: typeof o.timeout === "number" && o.timeout > 0 ? o.timeout : 0,
      };
      const argv = Array.isArray(args) ? args.map((a) => String(a)) : [];
      const execId = ++seq;
      const progressed = hostLater("extExec", [execId, inst, key, String(command), argv, opts]);
      const kill = () => __host("extExecKill", stringify([execId]));
      const sig = o.signal;
      if (sig !== undefined && sig !== null) {
        if (sig.aborted === true) kill();
        else if (typeof sig.addEventListener === "function") sig.addEventListener("abort", kill);
      }
      return progressed;
    },
    reload: () => {
      call("extReload", key, inst);
      return Promise.resolve(true);
    },
  });
  globalThis.__extFile = (f) => {
    file = f;
  };
  globalThis.__extReset = () => {
    for (const id of Object.keys(defs)) delete defs[id];
  };
  globalThis.__extForget = (f) => {
    for (const id of Object.keys(defs)) if (defs[id].file === f) delete defs[id];
  };
  globalThis.lightcode = Object.freeze({
    version: base.version,
    util: base.util,
    theme: base.theme,
    plugin(def) {
      if (def === null || typeof def !== "object" || typeof def.id !== "string") throw new Error("lightcode.plugin: a plugin needs an id");
      if (typeof def.agent !== "function") {
        delete defs[def.id];
        return;
      }
      defs[def.id] = { id: def.id, file: file, agent: def.agent };
    },
  });
  globalThis.__ext = {
    active() {
      const out = [];
      for (const id of Object.keys(defs)) out.push({ id: id, file: defs[id].file });
      return stringify(out);
    },
  };
  // The agent part of a plugin id for one instance: the host calls this per plugin, so its budget applies.
  const startAgent = fn((id, inst) => {
    const d = defs[id];
    if (d === undefined) throw new Error("lightcode.plugin: no agent for " + id);
    d.agent(agentFor(d.id + "\\u0000" + d.file, inst));
  });
  globalThis.__agentStartId = startAgent;
  const hostSettleId = fn((id, error, value) => hostSettle(id, error, value));
  globalThis.__hostSettleId = hostSettleId;
  const pluginDispatch = fn((inst, id, type, data) => {
    const list = appHandlers(inst, String(id), String(type)).slice();
    for (const f of list) {
      try {
        f(data);
      } catch (e) {
        __host("extLog", stringify([inst, "app " + String(type), messageOf(e)]));
      }
    }
  });
  globalThis.__extPluginId = pluginDispatch;
  globalThis.__invoke = (id, json) => {
    const f = fns[id];
    if (typeof f !== "function") throw new Error("plugin: no function " + String(id));
    const r = f(...parse(json));
    if (r !== null && typeof r === "object" && typeof r.then === "function") {
      const cid = ++seq;
      r.then(
        (v) => {
          __host("extSettle", stringify([cid, null, v === undefined ? null : v]));
        },
        (e) => {
          __host("extSettle", stringify([cid, messageOf(e), true]));
        },
      );
      return stringify({ __pending: cid });
    }
    return r === undefined ? "null" : stringify(r);
  };
})();`;

/** The prelude of a plugin engine: light's `__lightcodeBase`, then the harness's `lightcode` and agent. */
export const EXT_PRELUDE: string = buildPrelude("__lightcodeBase", HARNESS_THEME, "") + "\n" + AGENT_RUNTIME;
