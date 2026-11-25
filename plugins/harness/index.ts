// The harness plugin: lightcode's tools for the agent to probe and reshape lightcode itself, served
// over MCP like the ask plugin's (Claude Code sees them as mcp__lightcode__<name>, opencode as
// lightcode_<name>). screen reads the screen as drawn (every column but the chat unless named: the
// chat holds the agent's own text), state what runs (the columns, the tabs, every plugin with its
// state, the harness folder), log the last notes, api the plugin guide and the API's types, check a
// plugin source before it is saved, reload a plugin file (or every plugin) and say what it defined,
// config the configuration in use and where each part came from. The agent writes the files itself
// (.lightcode/plugins, prompt.md, config.json); these tools are how it sees the effect. For the user,
// /harness says what the folder's harness holds and /harness init writes its skeleton with Claude
// Code's skill for lightcode.

const { str, num, strs } = lightcode.util;

const SCREEN = {
  type: "object",
  properties: {
    columns: { type: "array", items: { type: "string" }, description: "The columns to read, by id (state lists them). Left out: every column but the chat, which holds your own conversation. []: the whole screen." },
  },
};
const LOG = { type: "object", properties: { n: { type: "integer", description: "How many of the last lines (50 when left out; 0 for every kept line, 300 at most)." } } };
const RELOAD = {
  type: "object",
  properties: {
    file: { type: "string", description: "The plugin file to evaluate again, relative to the project folder (.lightcode/plugins/name.js) or absolute. Left out: every plugin reloads, and the call answers that they did." },
  },
};
const API = {
  type: "object",
  properties: {
    part: { type: "string", description: "guide (PLUGINS.md's opening and its sections), a section of the guide by its heading (The harness, Agents, ...), or one part of the API by name: a namespace (tools, ui, state, agent, ...) or an interface (Tool, Plugin, Command, ...). types: the namespaces and interfaces to ask for. Left out, with no find: an index." },
    find: { type: "string", description: "Text to look up in the guide and the types: the lines holding it, with where they are." },
  },
};
const CHECK = {
  type: "object",
  properties: {
    code: { type: "string", description: "The plugin file's source." },
    file: { type: "string", description: "Its path, for the messages, and so that its own earlier version is not reported as a plugin it would replace." },
  },
  required: ["code"],
};
const NONE = { type: "object", properties: {} };

/** The block of the Api's namespace `name` in the types (`    name: {` to its closing brace), the interface or the type alias named `name`; "" for none. */
/** The guide's sections: each "## " heading with its text up to the next. */
const sectionsOf = (guide: string): { heading: string; text: string }[] => {
  const parts = guide.split(/\n(?=## )/);
  return parts.slice(1).map((t) => ({ heading: t.slice(3, t.indexOf("\n") < 0 ? t.length : t.indexOf("\n")).trim(), text: t }));
};

const partOf = (types: string, name: string): string => {
  const starts = ["\n    " + name + ": {", "\n  interface " + name + " {", "\n  type " + name + " ="];
  for (const start of starts) {
    const at = types.indexOf(start);
    if (at < 0) continue;
    if (start.endsWith("=")) return types.slice(at + 1, types.indexOf(";\n", at) + 1);
    let depth = 0;
    for (let i = types.indexOf("{", at); i < types.length; i++) {
      if (types[i] === "{") depth++;
      else if (types[i] === "}") {
        depth--;
        if (depth === 0) return types.slice(at + 1, i + 1);
      }
    }
  }
  return "";
};

/** The lines of `text` holding `needle` (case not counted), as `label:line: text`, `max` at most. */
const linesWith = (text: string, needle: string, label: string, max: number): string[] => {
  const out: string[] = [];
  const lower = needle.toLowerCase();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < max; i++) if (lines[i].toLowerCase().includes(lower)) out.push(label + ":" + String(i + 1) + ": " + lines[i].trim());
  return out;
};

/** The names matched by group 1 of `re` in `text`, each once. */
const namesIn = (text: string, re: RegExp): string[] => {
  const out: string[] = [];
  for (const m of text.matchAll(re)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
};

/** The folder's harness in a paragraph: trust, each plugin file with its state, the prompt, the config, the tools, the last errors. */
const report = (api: lightcode.Api): string => {
  const h = api.harness.info();
  const relative = (path: string): string => (path.startsWith(h.folder + "/") ? path.slice(h.folder.length + 1) : path);
  if (!h.present) return "This folder has no harness: /harness init writes .lightcode/ (prompt.md, plugins/example.js, config.json) and Claude Code's skill for lightcode.";
  const listed = api.plugins.list();
  const plugins = h.plugins.map((file) => {
    const states = listed.plugins.filter((p) => p.file === file).map((p) => p.id + " " + p.state + (p.problem.length > 0 ? ": " + p.problem : ""));
    return relative(file) + " (" + (states.length > 0 ? states.join(", ") : h.trusted ? "no plugin" : "not loaded") + ")";
  });
  const keys = Object.keys(h.config.project).filter((k) => (h.config.project as Record<string, unknown>)[k] !== null);
  const config = h.config.notice.length > 0 ? h.config.notice : !h.config.present ? "none" : !h.trusted ? "present, not in use" : keys.length > 0 ? keys.join(", ") : "nothing set";
  return (
    "Harness of " + h.folder + ": " + (h.trusted ? "trusted" : "not trusted (/trust runs it)") + ". Plugins: " + (plugins.length > 0 ? plugins.join(", ") : "none") +
    ". prompt.md: " + (h.prompt.length > 0 ? String(h.prompt.length) + " characters" : "none") + ". config.json: " + config + ". Tools: " + (h.tools.length > 0 ? h.tools.join(", ") : "none") +
    ". Last plugin errors: " + (listed.errors.length > 0 ? listed.errors.slice(-3).join(" | ") : "none") + "."
  );
};

lightcode.plugin({
  id: "harness",
  activate(api) {
    const settled = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        api.after(ms, () => resolve());
      });
    api.commands.add({
      name: "/harness",
      usage: "[init]",
      help: "this folder's harness (.lightcode: plugins, prompt, config, the agent's tools); init writes its skeleton and Claude Code's skill",
      complete: (typed) => ["init"].filter((v) => v.startsWith(typed.trim())),
      run: (arg) => {
        if (arg.trim() !== "init") {
          api.ui.notice(report(api));
          return;
        }
        const written = api.harness.init();
        const h = api.harness.info();
        if (written.length === 0) {
          api.tell("the harness is already there: nothing written (/harness shows it)");
          return;
        }
        for (const file of written) if (file.startsWith(h.dir + "/plugins/")) api.plugins.reload(file);
        const names = written.map((f) => (f.startsWith(h.folder + "/") ? f.slice(h.folder.length + 1) : f));
        api.ui.notice("Harness written: " + names.join(", ") + ". " + (h.trusted ? "The example plugin runs; /harness shows the harness." : "/trust runs it."));
      },
    });
    api.tools.add({
      name: "screen",
      description: "lightcode's screen as drawn, as text: every column but the chat unless columns names them (the chat holds your own conversation; name it to read it, or pass [] for the whole screen). Read it after a change to see what the user sees.",
      input: SCREEN,
      call: (args) => {
        const columns = args.columns === undefined ? api.state.columns().map((c) => c.id).filter((id) => id !== "chat") : strs(args.columns);
        return api.state.screen(columns);
      },
    });
    api.tools.add({
      name: "state",
      description: "What lightcode runs now: the folder, the active column, the columns and the side tabs, every plugin with its state (running, failed, off, replaced, stopped) and the last plugin errors, the keymap, the tools you have, and the harness folder (.lightcode: trusted or not, its plugin files, prompt and config).",
      input: NONE,
      call: () => {
        const active = api.state.active();
        const plugins = api.plugins.list();
        const h = api.harness.info();
        return {
          folder: active.folder,
          active,
          columns: api.state.columns(),
          panels: api.state.panels(),
          keymap: api.state.keymap(),
          plugins: plugins.plugins,
          errors: plugins.errors,
          tools: h.tools,
          harness: { dir: h.dir, present: h.present, trusted: h.trusted, plugins: h.plugins, prompt: h.prompt, config: { path: h.config.path, present: h.config.present, notice: h.config.notice } },
        };
      },
    });
    api.tools.add({
      name: "log",
      description: "The last lines of lightcode's log: what plugins noted, the status bar's messages, plugin errors with their file and line. Read it after saving a plugin to see whether it loaded.",
      input: LOG,
      call: (args) => api.state.log(num(args.n, 50)).join("\n"),
    });
    api.tools.add({
      name: "reload",
      description: "Evaluate a plugin file again now (a saved file reloads on its own within a moment; this makes sure, and answers what it defined), or every plugin when no file is named (the agent then restarts on its session at the turn's end). Answers the file's plugins with their states and the errors the reload raised.",
      input: RELOAD,
      call: async (args) => {
        const file = str(args.file);
        const before = api.plugins.list().errors;
        const refused = api.plugins.reload(file);
        if (refused.length > 0) throw new Error(refused);
        await settled(80);
        const now = api.plugins.list();
        const tail = file.slice(file.lastIndexOf("/") + 1);
        return { file, plugins: tail.length > 0 ? now.plugins.filter((p) => p.file.endsWith("/" + tail) || p.file === tail) : now.plugins, errors: now.errors.filter((e) => !before.includes(e)) };
      },
    });
    api.tools.add({
      name: "api",
      description: "The plugin API as this lightcode carries it: the guide (PLUGINS.md) and the types (lightcode.d.ts). part names what to read: guide, types, a namespace (tools, ui, state, agent, ...) or an interface (Tool, Plugin, Command, ...); find looks text up in both. Read the part you need before writing a plugin.",
      input: API,
      call: (args) => {
        const docs = api.plugins.api();
        const part = str(args.part);
        const find = str(args.find);
        if (find.length > 0) {
          const hits = linesWith(docs.guide, find, "PLUGINS.md", 40).concat(linesWith(docs.types, find, "lightcode.d.ts", 40));
          return hits.length > 0 ? hits.join("\n") : "nothing in the guide or the types holds " + JSON.stringify(find);
        }
        const namespaces = namesIn(partOf(docs.types, "Api"), /\n    ([a-zA-Z]+): \{/g);
        const interfaces = namesIn(docs.types, /\n  interface ([A-Za-z]+)/g);
        // The guide and the types are each larger than a tool's answer may be: they answer by part.
        const sections = sectionsOf(docs.guide);
        if (part === "guide") {
          const opening = docs.guide.split(/\n(?=## )/)[0];
          return opening.trimEnd() + "\n\nThe guide's sections, each a part to ask for: " + sections.map((x) => x.heading).join(", ") + ".";
        }
        if (part === "types") return "lightcode.d.ts by part. The namespaces of Api: " + namespaces.join(", ") + ". The interfaces: " + interfaces.join(", ") + ". find looks text up across it.";
        const section = sections.find((x) => x.heading.toLowerCase() === part.toLowerCase());
        if (section !== undefined) return section.text;
        if (part.length > 0) {
          const block = partOf(docs.types, part);
          if (block.length === 0) throw new Error("the API has no part named " + part + ". The namespaces: " + namespaces.join(", ") + ". The interfaces: " + interfaces.join(", "));
          return block;
        }
        return "The plugin API. part: guide (how plugins work, where they load from, the harness: its opening and its sections), a section of the guide by its heading, types (an index of the types), one of the namespaces (" + namespaces.join(", ") + ") or one of the interfaces (" + interfaces.join(", ") + "). find: text to look up in both.";
      },
    });
    api.tools.add({
      name: "check",
      description: "Check a plugin source before saving it: evaluated in a context of its own, nothing registered. Answers whether it loads, the plugins it defines with what they require, its errors (a syntax error, a plugin without id or activate) and warnings (a requirement no plugin provides, a running plugin it would replace, a write to globalThis).",
      input: CHECK,
      call: (args) => api.plugins.check(str(args.code), str(args.file)),
    });
    api.tools.add({
      name: "config",
      description: "The configuration in use and where each part came from: the user's config.json (~/.lightcode), the project's (.lightcode/config.json, when the folder is trusted), and the result of the project's over the user's, for the plugins' sections and the columns' widths; the project's permissions; a notice when the project's file could not be used.",
      input: NONE,
      call: () => api.harness.info().config,
    });
  },
});

export {};
