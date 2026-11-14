// The plugin API's `ui`, `keys`, `commands`, `languages`, `files` and `clipboard` calls, answered
// for the runtime (runtime.ts dispatches by namespace): the tabs, strips and segments plugins draw,
// their keys and commands, languages, the tree's rows, the clipboard.
import { PreludePart } from "@light/plugins/prelude.ts";
import type { JsRuntime } from "../runtime/runtime.ts";
import { Language, addLanguage } from "@lightstart/highlight/registry.ts";
import { TOKENIZERS, tokenizerFor } from "@lightstart/highlight/tokenizers.ts";
import { BandPart, SegmentContext, SegmentDef } from "@widecode/screen/contributions.ts";
import { Command, Suggestion } from "@light/kernel/commands.ts";
import { Action } from "@light/kernel/actions.ts";
import { KeymapDef } from "../controllers/keymaps.ts";
import { KeyEntry, Layer, keySpec } from "@light/kernel/keys.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { visibleRows } from "@light/workspace/tree.ts";
import { Run } from "@lightstart/light/native/tui/lines.ts";
import { OK } from "@light/plugins/engine.ts";
import { JsBand, JsPanel, PANEL_FNS, runsOf } from "../runtime/views.ts";
import { HostAnswer } from "@light/plugins/engine.ts";
import { str, num, strs, list, json, answer, answerText, objectText, refuse, listText } from "./values.ts";

/** A suggestion as a plugin answers one: a string, or { value, label, detail }; every field `unknown`. */
interface Suggested {
  value?: unknown;
  label?: unknown;
  detail?: unknown;
}

/** A completer's answer (JSON text of an array) as suggestions; strings are their own label. */
/** What runs plugin `owner`'s function `fn` for a key (its fields as JSON) and a count; true when the function answered true. */
const runner = (rt: JsRuntime, owner: string, fn: number): ((key: KeyEvent, count: number) => boolean) => (key: KeyEvent, count: number): boolean => {
  const v: unknown = { spec: keySpec(key.key, key.text, key.ctrl, key.alt, key.shift), name: key.key, text: key.text, ctrl: key.ctrl, alt: key.alt, shift: key.shift };
  const r = rt.invoke(owner, fn, json([v, count]));
  return r.status === OK && r.text === "true";
};

const suggestionsOf = (text: string): Suggestion[] => {
  const out: Suggestion[] = [];
  let v: unknown = null;
  try {
    v = JSON.parse(text);
  } catch {
    return out;
  }
  if (!Array.isArray(v)) return out;
  for (const x of v as unknown[]) {
    if (typeof x === "string") out.push(new Suggestion(x, x, ""));
    else if (x !== null && typeof x === "object" && !Array.isArray(x)) {
      const s = x as Suggested;
      const value = str(s.value);
      if (value.length > 0) out.push(new Suggestion(value, str(s.label).length > 0 ? str(s.label) : value, str(s.detail)));
    }
  }
  return out;
};

/** Plugin call `name` with its arguments `a`, answered; null for a call of another namespace. */
export const answerUi = (rt: JsRuntime, name: string, a: unknown[]): HostAnswer | null => {
  const h = rt.host;
  const k = h.kernel;
  switch (name) {
    case "commands.add": {
      const owner = str(a[0]);
      const fn = num(a[4]);
      const c = new Command(str(a[1]), str(a[2]), str(a[3]), owner, (arg: string) => {
        rt.invoke(owner, fn, json([arg]));
      });
      const complete = num(a[5]);
      if (complete >= 0)
        c.onComplete = (arg: string): Suggestion[] => {
          const r = rt.invoke(owner, complete, json([arg]));
          return r.status === OK ? suggestionsOf(r.text) : [];
        };
      k.commands.add(c);
      return answer(null);
    }
    case "commands.run":
      return answer(k.commands.run(str(a[0])));
    case "commands.remove":
      // Plugin `owner` drops its command `name`.
      return answer(k.commands.remove(str(a[1]), str(a[0])));
    case "keys.add": {
      // A key bound to a function of plugin `owner`: an action named after the key (`<owner>:<spec>`); a spec of "" is a hint alone (named after its text).
      const owner = str(a[0]);
      const spec = str(a[1]);
      const hint = str(a[3]);
      k.actions.add(new Action(owner + ":" + (spec.length > 0 ? spec : "hint:" + hint), str(a[2]), hint, spec.length > 0 ? [spec] : [], owner, runner(rt, owner, num(a[4]))));
      return answer(null);
    }
    case "keys.action": {
      // Action `id` of plugin `owner` in `scope`, with its help and default keys; its function gets the key and a count.
      const owner = str(a[0]);
      const id = str(a[1]);
      if (id.length === 0) return refuse("an action needs an id");
      k.actions.add(new Action(id, str(a[2]), str(a[3]), strs(a[4]), owner, runner(rt, owner, num(a[5]))));
      return answer(null);
    }
    case "keys.layer": {
      // A keymap of plugin `owner`: rows of [scope, spec, actions | null] (the prelude flattens the table).
      const owner = str(a[0]);
      const id = str(a[1]);
      if (id.length === 0) return refuse("a layer needs an id");
      const entries: KeyEntry[] = [];
      for (const v of list(a[2])) {
        const row = list(v);
        if (row.length < 3 || str(row[1]).length === 0) continue;
        entries.push(new KeyEntry(str(row[0]), str(row[1]), strs(row[2]), row[2] === null));
      }
      k.keys.addLayer(new Layer(id, owner, entries));
      return answer(null);
    }
    case "keys.keymap":
      // A keymap plugin `owner` brings, for /keymap's list; it turns its layers on when state.keymap names it.
      h.keys.add(new KeymapDef(str(a[1]), str(a[2]), str(a[0])));
      return answer(null);
    case "keys.run": {
      // Action `id` run `count` times over, as by a key named "none"; false when there is none or it did not take it.
      const act = k.actions.find(str(a[0]));
      return answer(act !== null && act.onRun(new KeyEvent("none", "", false, false, false), Math.max(1, num(a[1]))));
    }
    case "keys.on":
      return answer(k.keys.setLayer(str(a[0]), str(a[1]), true));
    case "keys.off":
      return answer(k.keys.setLayer(str(a[0]), str(a[1]), false));
    case "ui.panel": {
      const owner = str(a[0]);
      const fns: number[] = [];
      if (Array.isArray(a[4])) for (const f of a[4] as unknown[]) fns.push(num(f));
      while (fns.length < PANEL_FNS) fns.push(-1);
      const p = new JsPanel(rt, owner, str(a[1]), str(a[2]), num(a[3]), fns);
      p.column = str(a[5]) === "tools" ? "tools" : "side";
      rt.views.addPanel(p);
      h.screen.addPanel(owner, p);
      return answer(null);
    }
    case "ui.band": {
      const owner = str(a[0]);
      const b = new JsBand(rt, str(a[1]), owner, num(a[4]), num(a[5]));
      rt.views.addBand(b);
      h.screen.addBand(owner, new BandPart(str(a[1]), str(a[2]), num(a[3]), b));
      return answer(null);
    }
    case "ui.refresh": {
      const id = str(a[1]);
      for (const p of rt.views.panels) if (p.id === id && p.owner === str(a[0])) p.refresh();
      for (const b of rt.views.bands) if (b.id === id && b.owner === str(a[0])) b.refresh();
      return answer(null);
    }
    case "ui.reveal":
      for (const p of rt.views.panels) if (p.id === str(a[1]) && p.owner === str(a[0])) p.view.reveal(Math.max(0, num(a[2])), false);
      return answer(null);
    case "ui.segment": {
      const owner = str(a[0]);
      const draw = num(a[2]);
      const press = num(a[3]);
      h.screen.segments.add(
        new SegmentDef(
          str(a[1]),
          owner,
          (ctx: SegmentContext): Run[] => {
            const r = rt.invoke(owner, draw, "[" + rt.segmentContext(ctx) + "]");
            if (r.status !== OK) return [];
            let v: unknown = null;
            try {
              v = JSON.parse(r.text);
            } catch {
              return [];
            }
            return runsOf(v);
          },
          press >= 0
            ? () => {
                rt.invoke(owner, press, "[]");
              }
            : null,
        ),
      );
      return answer(null);
    }
    case "ui.drawSegment": {
      // A compiled plugin's segment, drawn for a JS one (the status table) from the context it was given.
      const def = h.screen.segments.find(str(a[0]));
      if (def === null) return answer(null);
      const given = a[1] !== null && typeof a[1] === "object" && !Array.isArray(a[1]) ? (a[1] as { folderName?: unknown; note?: unknown; busy?: unknown; spinner?: unknown; now?: unknown }) : null;
      const ctx = new SegmentContext();
      ctx.info = h.conversation.info;
      if (given !== null) {
        ctx.folderName = str(given.folderName);
        ctx.note = str(given.note);
        ctx.busy = given.busy === true;
        ctx.spinner = str(given.spinner);
        ctx.now = typeof given.now === "number" ? given.now : Date.now();
      }
      const parts: string[] = [];
      for (const r of def.draw(ctx)) parts.push(objectText(["text", "fg", "bg", "bold", "dim", "italic", "underline"], [json(r.text), json(r.fg), json(r.bg), json(r.bold), json(r.dim), json(r.italic), json(r.underline)]));
      return answerText("[" + parts.join(",") + "]");
    }
    case "ui.pressSegment": {
      const def = h.screen.segments.find(str(a[0]));
      const press = def !== null ? def.onSegmentPress : null;
      if (press === null) return answer(false);
      press();
      return answer(true);
    }
    case "ui.bell": {
      // The terminal's bell: the same write the clipboard uses, so a terminal beeps, flashes or hints.
      const write = rt.host.screen.clipboard.onWrite;
      if (write !== null) write("\x07");
      return answer(null);
    }
    case "ui.notice":
      // A notice in the chat, as /help answers: idle, after the last turn.
      h.conversation.model.notice(str(a[0]), "info", str(a[1]), "");
      h.conversationChanged.fire();
      return answer(null);
    case "languages.add": {
      // A language colored by one of the core's tokenizers.
      const tokenize = tokenizerFor(str(a[4]));
      if (tokenize === null) return refuse("languages.add: no tokenizer named " + json(str(a[4])) + " (the core has " + TOKENIZERS.join(", ") + ")");
      const l = new Language(str(a[1]), strs(a[2]).map((e: string) => e.toLowerCase()), strs(a[3]).map((f: string) => f.toLowerCase()), tokenize);
      l.owner = str(a[0]);
      addLanguage(l);
      return answer(null);
    }
    case "files.tree": {
      // The tree's visible rows for the folders a plugin opened (all of them, changed only, with the switch).
      const rows: string[] = [];
      for (const r of visibleRows(h.folder.tree(), new Set<string>(strs(a[0])), h.folder.marks(), a[1] === true))
        rows.push(objectText(["path", "name", "depth", "dir", "open", "mark"], [json(r.path), json(r.name), String(r.depth), json(r.dir), json(r.open), json(r.mark)]));
      return answerText(objectText(["total", "truncated", "changed", "rows"], [String(h.folder.paths().length), json(h.folder.truncated()), String(h.folder.changedCount()), listText(rows)]));
    }
    case "clipboard.copy":
      return answer(h.screen.copy(str(a[0])));
  }
  return null;
};

/** The `commands` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_COMMANDS = new PreludePart("commands", `        add: (c) => call("commands.add", id, String(c.name), String(c.usage ?? ""), String(c.help ?? ""), fn((arg) => { c.run(arg); }), typeof c.complete === "function" ? fn((arg) => c.complete(arg) ?? []) : -1),
        run: (text) => call("commands.run", String(text)),
        remove: (name) => call("commands.remove", id, String(name)),
`);

/** The `keys` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_KEYS = new PreludePart("keys", `        add: (spec, scope, hint, f) => call("keys.add", id, String(spec), String(scope ?? ""), String(hint ?? ""), fn((key, count) => (typeof f === "function" ? f(key, count) : false) === true)),
        // A keymap as rows of [scope, spec, actions | null]: the core reads a flat list.
        layer: (layerId, table) => {
          const rows = [];
          const t = table ?? {};
          for (const scope of Object.keys(t)) {
            const specs = t[scope] ?? {};
            for (const spec of Object.keys(specs)) {
              const v = specs[spec];
              rows.push([scope, spec, v === null ? null : Array.isArray(v) ? v.map(String) : [String(v)]]);
            }
          }
          call("keys.layer", id, String(layerId), rows);
          return Object.freeze({ on: () => call("keys.on", id, String(layerId)), off: () => call("keys.off", id, String(layerId)) });
        },
        run: (actionId, count) => call("keys.run", String(actionId), Number(count ?? 1)),
        keymap: (k) => call("keys.keymap", id, String(k.id), String(k.name ?? k.id)),
        action: (a) => call("keys.action", id, String(a.id), String(a.scope ?? ""), String(a.help ?? ""), Array.isArray(a.key) ? a.key.map(String) : a.key === undefined || a.key === null ? [] : [String(a.key)], fn((key, count) => a.run(key, count) === true)),
`);

/** The `ui` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_UI = new PreludePart("ui", `        panel: (p) => {
          const pid = String(p.id);
          call("ui.panel", id, pid, String(p.title ?? pid), Number(p.order ?? 50), [
            fn(() => p.count()),
            fn((from, count, width) => p.rows(from, count, width)),
            opt(p.info, () => p.info()),
            opt(p.width, (cols) => p.width(cols)),
            opt(p.press, (row, x) => { p.press(row, x); }),
            opt(p.infoPress, (x) => { p.infoPress(x); }),
            opt(p.shown, () => { p.shown(); }),
            opt(p.badge, () => p.badge()),
            opt(p.hidden, () => { p.hidden(); }),
          ], String(p.column ?? "side"));
          return Object.freeze({ refresh: () => call("ui.refresh", id, pid), reveal: (row) => call("ui.reveal", id, pid, Number(row)) });
        },
        band: (b) => {
          const bid = String(b.id);
          call("ui.band", id, bid, String(b.under ?? ""), Number(b.order ?? 50), fn((width) => b.lines(width)), typeof b.press === "function" ? fn((row, x) => { b.press(row, x); }) : -1);
          return Object.freeze({ refresh: () => call("ui.refresh", id, bid) });
        },
        segment: (s) => {
          call("ui.segment", id, String(s.name), fn((ctx) => s.draw(ctx)), typeof s.press === "function" ? fn(() => { s.press(); }) : -1);
        },
        notice: (text, detail) => call("ui.notice", String(text), String(detail ?? "")),
        bell: () => call("ui.bell"),
        drawSegment: (name, ctx) => call("ui.drawSegment", String(name), ctx),
        pressSegment: (name) => call("ui.pressSegment", String(name)),
`);

/** The `clipboard` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_CLIPBOARD = new PreludePart("clipboard", `        copy: (text) => call("clipboard.copy", String(text)),
`);

/** The `languages` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_LANGUAGES = new PreludePart("languages", `        add: (l) => call("languages.add", id, String(l.id), Array.from(l.extensions ?? [], String), Array.from(l.fences ?? [], String), String(l.tokenizer)),
`);

/** The `files` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_FILES = new PreludePart("files", `        tree: (expanded, changedOnly) => call("files.tree", Array.from(expanded ?? [], String), changedOnly === true),
`);
