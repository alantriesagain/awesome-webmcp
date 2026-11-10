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
    return {
    cwd: c.cwd,
    mode: c.mode,
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
  // A pi of its own per file and instance: what it registers or runs later is that instance's.
  const piFor = (file, instance) => ({
    on: (name, handler) => {
      call("extHandler", file, instance, name, handled(handler));
    },
    registerTool: (def) => {
      if (def === null || typeof def !== "object" || typeof def.name !== "string" || typeof def.execute !== "function") throw new Error("pi.registerTool: a tool needs a name and execute()");
      const id = fn((toolCallId, params, ctx) => {
        const c = ctxOf(ctx);
        return def.execute(toolCallId, params, c.signal, () => {}, c);
      });
      call("extTool", file, instance, def.name, def.label === undefined ? def.name : String(def.label), def.description === undefined ? "" : String(def.description), def.parameters === undefined ? { type: "object" } : def.parameters, id);
    },
    registerCommand: (name, def) => {
      if (typeof name !== "string" || def === null || typeof def !== "object" || typeof def.handler !== "function") throw new Error("pi.registerCommand: a command needs a name and handler()");
      const id = fn((args, ctx) => def.handler(args, ctxOf(ctx)));
      call("extCommand", file, instance, name, def.description === undefined ? "" : String(def.description), id);
    },
    exec: (command, args, options) => {
      const o = options === null || typeof options !== "object" ? {} : options;
      const opts = {
        cwd: typeof o.cwd === "string" ? o.cwd : "",
        timeout: typeof o.timeout === "number" && o.timeout > 0 ? o.timeout : 0,
      };
      const argv = Array.isArray(args) ? args.map((a) => String(a)) : [];
      const execId = ++seq;
      const progressed = hostLater("extExec", [execId, instance, file, String(command), argv, opts]);
      const kill = () => __host("extExecKill", stringify([execId]));
      const sig = o.signal;
      if (sig !== undefined && sig !== null) {
        if (sig.aborted === true) kill();
        else if (typeof sig.addEventListener === "function") sig.addEventListener("abort", kill);
      }
      return progressed;
    },
  });
  globalThis.__ext = {
    main: null,
    begin(f, i) {
      file = f;
      instance = i;
      __ext.main = null;
    },
    start() {
      const m = __ext.main;
      if (typeof m !== "function") throw new Error(file + ": no default export function");
      return m(piFor(file, instance));
    },
  };
  const start = fn(() => __ext.start());
  globalThis.__startId = start;
  const hostSettleId = fn((id, error, value) => hostSettle(id, error, value));
  globalThis.__hostSettleId = hostSettleId;
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
