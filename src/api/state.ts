// The plugin API's `state` and `settings` calls, answered for the runtime (runtime.ts dispatches by
// namespace): the folder's and the screen's state, a plugin's settings and kept state.
import { PreludePart } from "@lightstart/plugins/prelude.ts";
import type { JsRuntime } from "../runtime/runtime.ts";
import { HostAnswer } from "@lightstart/plugins/engine.ts";
import { str, num, strs, json, answer, answerText, objectText, refuse, listText } from "./values.ts";

/** Plugin call `name` with its arguments `a`, answered; null for a call of another namespace. */
export const answerState = (rt: JsRuntime, name: string, a: unknown[]): HostAnswer | null => {
  const h = rt.host;
  const k = h.kernel;
  switch (name) {
    case "settings.section":
      return answer(k.settings.section(str(a[0])));
    case "settings.state":
      return answer(k.settings.state(str(a[0])));
    case "settings.setState":
      k.settings.setState(str(a[0]), a[1]);
      return answer(null);
    case "state.real":
      return answer(h.real);
    case "state.note":
      return answer(h.screen.noteText());
    case "state.keymap":
      return answer(h.keys.keymap.value);
    case "state.folder": {
      const marks: string[] = [];
      const markValues: string[] = [];
      for (const path of h.folder.marks().keys()) {
        marks.push(path);
        markValues.push(json(h.folder.marks().get(path) ?? ""));
      }
      const counts: string[] = [];
      const countValues: string[] = [];
      for (const path of h.folder.counts().keys()) {
        const c = h.folder.counts().get(path);
        if (c === undefined) continue;
        counts.push(path);
        countValues.push("[" + String(c.added) + "," + String(c.removed) + "," + String(c.binary) + "]");
      }
      return answerText(objectText(["branch", "repo", "truncated", "marks", "counts"], [json(h.folder.branch()), json(h.workspace.repo.isRepo), json(h.folder.truncated()), objectText(marks, markValues), objectText(counts, countValues)]));
    }
    case "state.paths":
      return answer(h.folder.paths());
    case "state.batch":
      return answerText(objectText(["paths", "structure", "git"], [json(h.folder.batch.paths), json(h.folder.batch.structure), json(h.folder.batch.git)]));
    case "state.panels": {
      const ids: string[] = [];
      for (const p of h.screen.panelsIn("side")) ids.push(p.id);
      return answer(ids);
    }
    case "state.changes": {
      const out: string[] = [];
      for (const f of h.changes()) out.push(objectText(["path", "mark", "added", "removed", "binary", "changedMs", "byAgent"], [json(f.path), json(f.mark), String(f.added), String(f.removed), json(f.binary), String(f.changedMs), json(f.byAgent)]));
      return answerText("[" + out.join(",") + "]");
    }
    case "state.base":
      return answerText(objectText(["base", "kind", "name"], [json(h.folder.base.peek().base), json(h.folder.base.peek().kind), json(h.folder.base.peek().name)]));
    case "state.active":
      return answerText(objectText(["column", "panel", "folder", "folderName"], [json(h.screen.active.peek()), json(h.screen.shownIn(h.screen.panelsIn(h.screen.active.peek()).length > 0 ? h.screen.active.peek() : "side")), json(h.workspace.folder), json(h.folder.folderName())]));
    case "state.info":
      return answerText(h.conversation.info.json(Date.now()));
    case "state.screen": {
      const fn = h.screen.onScreen;
      if (fn === null) return refuse("the screen is not drawn here");
      return answer(fn(strs(a[0])));
    }
    case "state.log": {
      const n = num(a[0]);
      return answer(n > 0 ? h.notes.slice(-n) : h.notes.slice());
    }
    case "state.commands": {
      const out: string[] = [];
      for (const c of k.commands.all()) out.push(objectText(["name", "usage", "help", "owner"], [json(c.name), json(c.usage), json(c.help), json(c.owner)]));
      return answerText(listText(out));
    }
    case "state.columns": {
      const out: string[] = [];
      const active = h.screen.active.peek();
      for (const c of h.screen.columns) out.push(objectText(["id", "title", "active"], [json(c.id), json(c.title), json(c.id === active)]));
      return answerText(listText(out));
    }
  }
  return null;
};

/** The `settings` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_SETTINGS = new PreludePart("settings", `        section: () => call("settings.section", id),
        state: () => call("settings.state", id),
        setState: (value) => call("settings.setState", id, value === undefined ? null : value),
`);

/** The `state` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_STATE = new PreludePart("state", `        folder: () => call("state.folder"),
        paths: () => call("state.paths"),
        changes: () => call("state.changes"),
        panels: () => call("state.panels"),
        batch: () => call("state.batch"),
        base: () => call("state.base"),
        active: () => call("state.active"),
        info: () => call("state.info"),
        real: () => call("state.real"),
        note: () => call("state.note"),
        keymap: () => call("state.keymap"),
        screen: (columns) => call("state.screen", Array.from(columns ?? [], String)),
        log: (n) => call("state.log", Number(n ?? 0)),
        commands: () => call("state.commands"),
        columns: () => call("state.columns"),
`);
