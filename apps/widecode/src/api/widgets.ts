// The plugin API's `code`, `chat` and `widgets` calls, answered for the runtime (runtime.ts
// dispatches by namespace): the chat and code columns' roles, and the core's widgets a plugin
// mounts as columns and tabs.
import { PreludePart } from "@light/plugins/prelude.ts";
import type { JsRuntime } from "../runtime/runtime.ts";
import { OK } from "@light/plugins/engine.ts";
import { HostAnswer } from "@light/plugins/engine.ts";
import { str, num, strs, json, answer, answerText, objectText, refuse, commitOf, cells } from "./values.ts";
import { JsRows } from "../runtime/views.ts";
import { insertText } from "@bootstrapp/light/native/tui";

/** A code view's key in the runtime's table: the plugin's id and the view's. */
const viewKey = (owner: string, id: string): string => owner + "\n" + id;

/** Plugin call `name` with its arguments `a`, answered; null for a call of another namespace. */
export const answerWidgets = (rt: JsRuntime, name: string, a: unknown[]): HostAnswer | null => {
  const h = rt.host;
  switch (name) {
    case "code.open":
      h.roles.code.open(str(a[0]));
      return answer(null);
    case "widgets.code": {
      // The code widget as plugin `owner`'s column; its wrap switch reported to `onWrap`.
      const widget = rt.code;
      if (widget === null) return refuse("widgets.code: no code widget in rt build");
      const owner = str(a[0]);
      const onWrap = num(a[3]);
      const l = rt.life(owner);
      widget.mount(owner, str(a[1]), num(a[2]));
      widget.pane.onWrap =
        onWrap >= 0
          ? () => {
              if (rt.alive(l)) rt.invoke(owner, onWrap, "[" + json(widget.pane.wrap.peek()) + "]");
            }
          : null;
      return answer(null);
    }
    case "widgets.chat": {
      // The chat widget as plugin `owner`'s column, `width` cells wide at a terminal's columns; a line from its composer goes to `onLine`.
      const widget = rt.chat;
      if (widget === null) return refuse("widgets.chat: no chat widget in rt build");
      const owner = str(a[0]);
      const widthFn = num(a[3]);
      const lineFn = num(a[4]);
      const l = rt.life(owner);
      const live = (): boolean => rt.alive(l);
      widget.mount(owner, str(a[1]), num(a[2]), (cols: number): number => {
        const half = Math.max(20, Math.floor(cols / 2));
        if (widthFn < 0 || !live()) return half;
        const r = rt.invoke(owner, widthFn, "[" + String(cols) + "]");
        return cells(r.status === OK ? (JSON.parse(r.text) as unknown) : null, half);
      });
      widget.onLine =
        lineFn >= 0
          ? (text: string) => {
              if (live()) rt.invoke(owner, lineFn, "[" + json(text) + "]");
            }
          : null;
      return answer(null);
    }
    case "widgets.tools": {
      // The Tools tab as plugin `owner`'s, in the tools column.
      const widget = rt.tools;
      if (widget === null) return refuse("widgets.tools: no tools widget in rt build");
      widget.mount(str(a[0]), str(a[1]), num(a[2]));
      return answer(null);
    }
    case "chat.loadEarlier":
      if (rt.chat !== null) rt.chat.pane.loadEarlier();
      return answer(null);
    case "chat.toTop":
      if (rt.chat !== null) rt.chat.pane.view.toTop();
      return answer(null);
    case "chat.toEnd":
      if (rt.chat !== null) rt.chat.pane.view.toEnd();
      return answer(null);
    case "code.openAgent":
      h.roles.code.openAgent(str(a[0]));
      return answer(null);
    case "code.openCall":
      h.roles.code.openCall(str(a[0]));
      return answer(null);
    case "code.inAgent":
      return answer(h.roles.code.inAgent());
    case "code.view": {
      // A view plugin `owner` draws in the code column: its rows come from the plugin as a tab's do; shown with code.show.
      const owner = str(a[0]);
      const rows = new JsRows(rt, owner, num(a[2]), num(a[3]));
      rt.views.setCodeView(viewKey(owner, str(a[1])), rows);
      return answer(null);
    }
    case "code.show": {
      const owner = str(a[0]);
      const rows = rt.views.codeView(viewKey(owner, str(a[1])));
      if (rows === null) return refuse("no such view: " + str(a[1]));
      const pressFn = num(a[3]);
      rows.invalidate();
      h.roles.code.openView(rows, str(a[2]), pressFn >= 0 ? (row: number) => { rt.invoke(owner, pressFn, JSON.stringify([row])); } : null);
      return answer(null);
    }
    case "code.refresh": {
      const rows = rt.views.codeView(viewKey(str(a[0]), str(a[1])));
      if (rows !== null && rt.code !== null && rt.code.pane.view.source === rows) {
        rows.invalidate();
        rt.code.pane.view.refresh();
      }
      return answer(null);
    }
    case "code.shown": {
      const rows = rt.views.codeView(viewKey(str(a[0]), str(a[1])));
      return answer(rows !== null && rt.code !== null && rt.code.pane.view.source === rows);
    }
    case "code.scroll":
      if (rt.code !== null) rt.code.pane.view.scroll(num(a[0]));
      return answer(null);
    case "code.toTop":
      if (rt.code !== null) rt.code.pane.view.toTop();
      return answer(null);
    case "code.toEnd":
      if (rt.code !== null) rt.code.pane.view.toEnd();
      return answer(null);
    case "code.moveHunk":
      if (rt.code !== null) rt.code.pane.moveHunk(num(a[0]) < 0 ? -1 : 1);
      return answer(null);
    case "code.wrap":
      return answer(rt.code !== null && rt.code.pane.wrap.peek());
    case "code.setWrap":
      if (rt.code !== null && rt.code.pane.wrap.peek() !== (a[0] === true)) rt.code.pane.toggleWrap();
      return answer(null);
    case "code.openCommit": {
      const c = commitOf(a[0]);
      if (c === null) return refuse("code.openCommit: a commit is { sha, short, subject, parents }");
      h.roles.code.openCommit(c, str(a[1]), str(a[2]));
      return answer(null);
    }
    case "code.path":
      return answer(h.roles.code.path());
    case "code.inCommit":
      return answer(h.roles.code.inCommit());
    case "code.position":
      return answer(h.roles.code.position());
    case "chat.submit":
      h.roles.chat.submit(str(a[0]));
      return answer(null);
    case "composer.get": {
      // The composer's lines and caret, and whether it is empty, the suggestion strip shows, the request panel is open.
      const chat = rt.chat;
      if (chat === null) return answerText('{"lines":[""],"row":0,"col":0,"empty":true,"strip":false,"panel":false}');
      const i = chat.pane.input;
      return answerText(objectText(["lines", "row", "col", "empty", "strip", "panel"], [json(i.lines), String(i.row), String(i.col), json(i.isEmpty()), json(chat.pane.strip.visible), json(chat.pane.panel.active)]));
    }
    case "composer.set":
      // Its lines and caret (clamped).
      if (rt.chat !== null) rt.chat.pane.composer.set(strs(a[0]), num(a[1]), num(a[2]));
      return answer(null);
    case "composer.insert":
      if (rt.chat !== null) insertText(rt.chat.pane.input, str(a[0]));
      return answer(null);
    case "composer.setLabel":
      // The composer's border title ("You"; a keymap's mode indicator).
      if (rt.chat !== null) rt.chat.pane.label.value = str(a[0]);
      return answer(null);
    case "chat.showChat":
      h.roles.chat.showChat();
      return answer(null);
  }
  return null;
};

/** The `code` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_CODE = new PreludePart("code", `        open: (path) => call("code.open", String(path)),
        openCommit: (commit, path, mark) => call("code.openCommit", commit, String(path), String(mark ?? "M")),
        path: () => call("code.path"),
        inCommit: () => call("code.inCommit"),
        position: () => call("code.position"),
        openAgent: (agent) => call("code.openAgent", String(agent)),
        openCall: (call_) => call("code.openCall", String(call_)),
        inAgent: () => call("code.inAgent"),
        view: (v) => {
          const vid = String(v.id);
          const press = typeof v.press === "function" ? fn((row) => { v.press(row); }) : -1;
          call("code.view", id, vid, fn(() => v.count()), fn((from, count, width) => v.rows(from, count, width)));
          return Object.freeze({ show: (title) => call("code.show", id, vid, String(title ?? vid), press), refresh: () => call("code.refresh", id, vid), shown: () => call("code.shown", id, vid) });
        },
        scroll: (rows) => call("code.scroll", Number(rows)),
        toTop: () => call("code.toTop"),
        toEnd: () => call("code.toEnd"),
        moveHunk: (direction) => call("code.moveHunk", Number(direction)),
        wrap: () => call("code.wrap"),
        setWrap: (on) => call("code.setWrap", on === true),
`);

/** The `composer` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_COMPOSER = new PreludePart("composer", `        get: () => call("composer.get"),
        set: (lines, row, col) => call("composer.set", Array.from(lines ?? [""], String), Number(row ?? 0), Number(col ?? 0)),
        insert: (text) => call("composer.insert", String(text)),
        setLabel: (text) => call("composer.setLabel", String(text)),
`);

/** The `chat` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_CHAT = new PreludePart("chat", `        submit: (text) => call("chat.submit", String(text)),
        showChat: () => call("chat.showChat"),
        loadEarlier: () => call("chat.loadEarlier"),
        toTop: () => call("chat.toTop"),
        toEnd: () => call("chat.toEnd"),
`);

/** The `widgets` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_WIDGETS = new PreludePart("widgets", `        chat: (w) => call("widgets.chat", id, String(w.title ?? "Chat"), Number(w.order ?? 0), typeof w.width === "function" ? fn((cols) => w.width(cols)) : -1, typeof w.onLine === "function" ? fn((text) => { w.onLine(text); }) : -1),
        code: (w) => call("widgets.code", id, String(w.title ?? "Code"), Number(w.order ?? 2), typeof w.onWrap === "function" ? fn((on) => { w.onWrap(on); }) : -1),
        tools: (w) => call("widgets.tools", id, String(w.title ?? "Tools"), Number(w.order ?? 0)),
`);
