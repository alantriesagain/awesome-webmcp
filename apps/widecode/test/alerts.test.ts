// ffi: @light/plugins/native/ffi.json
// Alerts when a request opens in the request panel: the terminal bell (the BEL the clipboard's
// write carries in tests) and the notify-send command, recorded in a script of the test's; a
// category left out of "on"; bell and notify each turned off; the plugin switched off; two
// requests alert twice, one never twice, and a request answered at once does not alert. Alerts
// run only in the real app (the host's flag, as startup.ts sets it), and a notification click
// runs the section's onClick line and shows its request.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { TOOL } from "@widecode/conversation/model.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { createWidecode, Widecode } from "../src/compose.ts";
import { done, eq, ok } from "@light/test/assert.ts";
import { until } from "@light/test/headless.ts";

interface App {
  w: Widecode;
  c: Conversation;
  rings: string[];
  log: string;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-alerts-"));
  const ws = await openWorkspace(folder, 100);
  const recorder = join(folder, "notify.sh");
  writeFileSync(recorder, "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$WIDECODE_ALERTS_LOG\"\n");
  chmodSync(recorder, 0o755);
  let run = 0;

  const make = (plugins: unknown, real = true): App => {
    const log = join(folder, "notify-" + String(++run) + ".log");
    process.env["WIDECODE_ALERTS_LOG"] = log;
    const c = new Conversation(ws.folder);
    const w = createWidecode(ws, c, plugins);
    // What startup.ts sets in the real entry alone; a test never reaches the user's desktop otherwise.
    w.host.real = real;
    const rings: string[] = [];
    w.host.screen.clipboard.onWrite = (text: string) => rings.push(text);
    return { w, c, rings, log };
  };

  const open = (app: App, id: string, category: string, name: string, summary: string): void => {
    const item = app.c.model.openRequest(id, name, "tool-" + id, null);
    item.category = category;
    item.summary = summary;
    app.c.changed();
  };

  const quiet = async (app: App): Promise<string> => {
    await wait(150);
    return existsSync(app.log) ? readFileSync(app.log, "utf8") : "";
  };

  let app = make({ alerts: { notifyCommand: [recorder] } }, false);
  open(app, "req-1", "permission", "Bash", "Bash git push origin main: allow it?");
  eq("a test never alerts: no bell, no notify-send", (await quiet(app)) + " " + String(app.rings.length), " 0");
  app.w.host.kernel.stop();

  app = make({ alerts: { notifyCommand: [recorder] } });
  open(app, "req-1", "permission", "Bash", "Bash git push origin main: allow it?");
  ok("a permission alerts: the bell rings once", await until(() => app.rings.length > 0, 3000) && app.rings.join("") === "\x07");
  eq("notify-send gets the kind and the one-line summary", await until(() => existsSync(app.log) && readFileSync(app.log, "utf8") === "widecode: permission\nBash git push origin main: allow it?\n", 3000) ? readFileSync(app.log, "utf8") : "", "widecode: permission\nBash git push origin main: allow it?\n");
  app.w.host.kernel.stop();

  app = make({ alerts: { on: ["permission"], notifyCommand: [recorder] } });
  open(app, "req-1", "question", "AskUserQuestion", "Which color?");
  eq("a category not in \"on\" does not alert", (await quiet(app)) + " " + String(app.rings.length), " 0");
  app.w.host.kernel.stop();

  app = make({ alerts: { bell: false, notifyCommand: [recorder] } });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  eq("bell false: no bell, the notification still goes", (await until(() => existsSync(app.log), 3000) ? readFileSync(app.log, "utf8") : "") + " " + String(app.rings.length), "widecode: permission\nBash ls: allow it?\n 0");
  app.w.host.kernel.stop();

  app = make({ alerts: { notify: false } });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  eq("notify false: the bell rings, no command runs", (await quiet(app)) + " " + app.rings.join(""), " " + "\x07");
  app.w.host.kernel.stop();

  app = make({ alerts: false });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  eq("the plugin switched off alerts nothing", (await quiet(app)) + " " + String(app.rings.length), " 0");
  app.w.host.kernel.stop();

  app = make({ alerts: { notifyCommand: [recorder] } });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  app.c.changed();
  eq("one request never alerts twice", String(await until(() => app.rings.length > 0, 3000) && (await wait(100), app.rings.length === 1 && app.rings.join("") === "\x07")), "true");
  open(app, "req-2", "question", "AskUserQuestion", "Which color?");
  ok("two requests alert twice", await until(() => app.rings.length === 2, 3000) && app.rings.join("") === "\x07\x07");
  eq("and notify-send ran once for each", await until(() => existsSync(app.log) && readFileSync(app.log, "utf8") === "widecode: permission\nBash ls: allow it?\nwidecode: question\nWhich color?\n", 3000) ? readFileSync(app.log, "utf8") : "", "widecode: permission\nBash ls: allow it?\nwidecode: question\nWhich color?\n");

  const item = app.c.model.openRequest("req-3", "Bash", "tool-3", null);
  item.category = "permission";
  item.summary = "Bash rm: allow it?";
  app.c.model.settle("req-3", "answered");
  app.c.changed();
  eq("a request answered at once does not alert", String(app.rings.length), "2");

  // A background subagent's question opens under its card in a turn many turns back.
  const m = app.c.model;
  m.openTurn("delegate", 0, true);
  const card = m.block("", "tc-bg", TOOL, "toolu-bg", "Task", "");
  m.closeTurn(null);
  for (const text of ["one", "two", "three"]) {
    m.openTurn(text, 0, true);
    m.closeTurn(null);
    app.c.changed();
  }
  m.openTurn("now", 0, true);
  app.c.changed();
  const late = m.openRequest("req-bg", "Task", "", null, card !== null ? "toolu-bg" : "");
  late.category = "question";
  late.summary = "rm a.txt asks for permission";
  app.c.changed();
  ok("a question under an earlier turn's card alerts too", await until(() => app.rings.length === 3, 3000));
  app.w.host.kernel.stop();

  // notify-send's action: when it prints `open`, the section's onClick line runs and the request shows.
  const clicker = join(folder, "click.sh");
  const clicked = join(folder, "clicked.txt");
  writeFileSync(clicker, "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$WIDECODE_ALERTS_LOG\"\nprintf 'open\\n'\n");
  chmodSync(clicker, 0o755);
  app = make({ alerts: { notifyCommand: [clicker], onClick: "touch " + clicked } });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  eq("the notification asks for the open action", await until(() => existsSync(app.log) && readFileSync(app.log, "utf8") === "-A\nopen=Open\nwidecode: permission\nBash ls: allow it?\n", 3000) ? readFileSync(app.log, "utf8") : "", "-A\nopen=Open\nwidecode: permission\nBash ls: allow it?\n");
  ok("a click runs onClick", await until(() => existsSync(clicked), 3000));
  ok("and shows its request in the chat", await until(() => app.w.chat.pane.panel.item?.requestId === "req-1", 3000) && app.w.host.screen.active.peek() === "chat");
  app.w.host.kernel.stop();

  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
