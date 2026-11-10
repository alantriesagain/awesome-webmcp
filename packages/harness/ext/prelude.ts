// The JS side of the harness's extension API: the `pi` object an extension's default export is
// called with, its handler and tool tables, and the answer path for a callback that returns a
// promise (the prelude tells the host the call's id and the settled value or error, and the host
// keeps the turn going meanwhile). Mirrors the app runtime's toolCall/toolDone shape.
export const EXT_PRELUDE: string =
  `"use strict";
(() => {
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const fns = [];
  let seq = 0;
  let file = "";
  const call = (name, ...args) => parse(__host(name, stringify(args)));
  const fn = (f) => {
    fns.push(f);
    return fns.length - 1;
  };
  const messageOf = (e) => (e !== null && typeof e === "object" && typeof e.message === "string" ? e.message : String(e));
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
    return {
    cwd: c.cwd,
    mode: c.mode,
    hasUI: c.hasUI === true,
    model: c.model === undefined ? null : c.model,
    signal,
    abort: () => {
      signal.__fire();
      __host("extAbort", "[]");
    },
    isIdle: () => parse(__host("extIsIdle", "[]")),
    getContextUsage: () => parse(__host("extContextUsage", "[]")),
    getSystemPrompt: () => parse(__host("extSystemPrompt", "[]")),
    ui: {
      select: () => Promise.resolve(undefined),
      input: () => Promise.resolve(undefined),
      editor: () => Promise.resolve(undefined),
      confirm: () => Promise.resolve(false),
      notify: (message, type) => {
        __host("extUi", stringify(["notify", message, type === undefined ? "" : type]));
      },
      setStatus: (key, text) => {
        __host("extUi", stringify(["setStatus", key, text === undefined ? null : text]));
      },
      setWidget: (key, content) => {
        __host("extUi", stringify(["setWidget", key, Array.isArray(content) ? content : null]));
      },
      setTitle: (title) => {
        __host("extUi", stringify(["setTitle", title]));
      },
    },
    };
  };
  const handled = (handler) =>
    fn((event, ctx) => {
      const r = handler(event, ctxOf(ctx));
      if (r !== null && typeof r === "object" && typeof r.then === "function") return r.then((v) => ({ result: v === undefined ? null : v, input: event.input }));
      return { result: r === undefined ? null : r, input: event.input };
    });
  const pi = {
    on: (name, handler) => {
      call("extHandler", file, name, handled(handler));
    },
    registerTool: (def) => {
      if (def === null || typeof def !== "object" || typeof def.name !== "string" || typeof def.execute !== "function") throw new Error("pi.registerTool: a tool needs a name and execute()");
      const id = fn((toolCallId, params, ctx) => {
        const c = ctxOf(ctx);
        return def.execute(toolCallId, params, c.signal, () => {}, c);
      });
      call("extTool", file, def.name, def.label === undefined ? def.name : String(def.label), def.description === undefined ? "" : String(def.description), def.parameters === undefined ? { type: "object" } : def.parameters, id);
    },
    registerCommand: (name, def) => {
      if (typeof name !== "string" || def === null || typeof def !== "object" || typeof def.handler !== "function") throw new Error("pi.registerCommand: a command needs a name and handler()");
      const id = fn((args, ctx) => def.handler(args, ctxOf(ctx)));
      call("extCommand", file, name, def.description === undefined ? "" : String(def.description), id);
    },
  };
  globalThis.__ext = {
    main: null,
    begin(f) {
      file = f;
      __ext.main = null;
    },
    start() {
      const m = __ext.main;
      if (typeof m !== "function") throw new Error(file + ": no default export function");
      return m(pi);
    },
  };
  const start = fn(() => __ext.start());
  globalThis.__startId = start;
  globalThis.__invoke = (id, json) => {
    const f = fns[id];
    if (typeof f !== "function") throw new Error("extension: no function " + String(id));
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
})();
`;
