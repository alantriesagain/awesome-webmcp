// ffi: @lightstart/plugins/native/ffi.json
// Alerts when a request opens in the request panel: the terminal bell (the BEL the clipboard's
// write carries in tests) and the notify-send command, recorded in a script of the test's; a
// category left out of "on"; bell and notify each turned off; the plugin switched off; two
// requests alert twice, one never twice, and a request answered at once does not alert. Alerts
// run only in the real app (the host's flag, as the widecode controller sets it), and a notification click
// runs the section's onClick line and shows its request. A notify-send notification gets the
// section's expire time as -t and runs under coreutils timeout, a custom notifyCommand gets no -t,
// and a bad expireSeconds falls back to 600.
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation } from "../src/conversation/conversation.ts";
import { TOOL } from "../src/conversation/model.ts";
import type { Widecode } from "../src/compose.ts";
import { closeWidecode, openWidecode } from "./support/app.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";
import { until } from "@lightstart/test/headless.ts";

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
  const recorder = join(folder, "notify.sh");
  writeFileSync(recorder, "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$WIDECODE_ALERTS_LOG\"\n");
  chmodSync(recorder, 0o755);
  const notifier = (name: string): string => {
    const dir = join(folder, name);
    mkdirSync(dir);
    const path = join(dir, "notify-send");
    writeFileSync(path, "#!/bin/sh\n{ printf 'args\\n'; printf '%s\\n' \"$@\"; printf 'parent\\n'; tr '\\0' '\\n' < /proc/$PPID/cmdline; } >> \"$WIDECODE_ALERTS_LOG\"\n");
    chmodSync(path, 0o755);
    return path;
  };
  let run = 0;

  const make = async (plugins: unknown, real = true): Promise<App> => {
    const log = join(folder, "notify-" + String(++run) + ".log");
    process.env["WIDECODE_ALERTS_LOG"] = log;
    const rings: string[] = [];
    const w = await openWidecode({
      folder,
      plugins,
      before: (w: Widecode) => {
        // What the widecode controller sets in the real app alone; a test never reaches the user's desktop otherwise.
        w.host.real = real;
        w.host.screen.clipboard.onWrite = (text: string) => rings.push(text);
      },
    });
    return { w, c: w.host.conversation, rings, log };
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

  const capture = async (app: App): Promise<string> => {
    await until(() => existsSync(app.log), 3000);
    await wait(100);
    return existsSync(app.log) ? readFileSync(app.log, "utf8") : "";
  };

  let app = await make({ alerts: { notifyCommand: [recorder] } }, false);
  open(app, "req-1", "permission", "Bash", "Bash git push origin main: allow it?");
  eq("a test never alerts: no bell, no notify-send", (await quiet(app)) + " " + String(app.rings.length), " 0");
  closeWidecode(app.w);

  app = await make({ alerts: { notifyCommand: [recorder] } });
  open(app, "req-1", "permission", "Bash", "Bash git push origin main: allow it?");
  ok("a permission alerts: the bell rings once", await until(() => app.rings.length > 0, 3000) && app.rings.join("") === "\x07");
  eq("notify-send gets the kind and the one-line summary", await until(() => existsSync(app.log) && readFileSync(app.log, "utf8") === "widecode: permission\nBash git push origin main: allow it?\n", 3000) ? readFileSync(app.log, "utf8") : "", "widecode: permission\nBash git push origin main: allow it?\n");
  closeWidecode(app.w);

  app = await make({ alerts: { on: ["permission"], notifyCommand: [recorder] } });
  open(app, "req-1", "question", "AskUserQuestion", "Which color?");
  eq("a category not in \"on\" does not alert", (await quiet(app)) + " " + String(app.rings.length), " 0");
  closeWidecode(app.w);

  app = await make({ alerts: { bell: false, notifyCommand: [recorder] } });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  eq("bell false: no bell, the notification still goes", (await until(() => existsSync(app.log), 3000) ? readFileSync(app.log, "utf8") : "") + " " + String(app.rings.length), "widecode: permission\nBash ls: allow it?\n 0");
  closeWidecode(app.w);

  app = await make({ alerts: { notify: false } });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  eq("notify false: the bell rings, no command runs", (await quiet(app)) + " " + app.rings.join(""), " " + "\x07");
  closeWidecode(app.w);

  app = await make({ alerts: false });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  eq("the plugin switched off alerts nothing", (await quiet(app)) + " " + String(app.rings.length), " 0");
  closeWidecode(app.w);

  app = await make({ alerts: { notifyCommand: [recorder] } });
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
  closeWidecode(app.w);

  // notify-send's own expire time and the coreutils timeout around the line, from its parent's argv.
  app = await make({ alerts: { notifyCommand: [notifier("default-expire")] } });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  const defaultLine = await capture(app);
  eq("the default expire is -t 600000", defaultLine.split("parent\n")[0], "args\n-t\n600000\nwidecode: permission\nBash ls: allow it?\n");
  ok("the default expire line runs under timeout 605", defaultLine.includes("parent\ntimeout\n605\n") && defaultLine.includes("\n-t\n600000\nwidecode: permission\n"));
  closeWidecode(app.w);

  app = await make({ alerts: { notifyCommand: [notifier("configured-expire")], expireSeconds: 30 } });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  const configuredLine = await capture(app);
  eq("a configured expireSeconds is -t 30000", configuredLine.split("parent\n")[0], "args\n-t\n30000\nwidecode: permission\nBash ls: allow it?\n");
  ok("a configured expireSeconds bounds timeout at 35", configuredLine.includes("parent\ntimeout\n35\n") && configuredLine.includes("\n-t\n30000\n"));
  closeWidecode(app.w);

  app = await make({ alerts: { notifyCommand: [notifier("bad-expire")], expireSeconds: "soon" } });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  const badLine = await capture(app);
  ok("an invalid expireSeconds falls back to the default", badLine.includes("parent\ntimeout\n605\n") && badLine.includes("\n-t\n600000\n"));
  closeWidecode(app.w);

  app = await make({ alerts: { notifyCommand: [recorder] } });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  const customLine = await capture(app);
  eq("a custom notifyCommand gets no -t", customLine, "widecode: permission\nBash ls: allow it?\n");
  closeWidecode(app.w);

  // notify-send's action: when it prints `open`, the section's onClick line runs and the request shows.
  const clicker = join(folder, "click.sh");
  const clicked = join(folder, "clicked.txt");
  writeFileSync(clicker, "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$WIDECODE_ALERTS_LOG\"\nprintf 'open\\n'\n");
  chmodSync(clicker, 0o755);
  app = await make({ alerts: { notifyCommand: [clicker], onClick: "touch " + clicked } });
  open(app, "req-1", "permission", "Bash", "Bash ls: allow it?");
  eq("the notification asks for the open action", await until(() => existsSync(app.log) && readFileSync(app.log, "utf8") === "-A\nopen=Open\nwidecode: permission\nBash ls: allow it?\n", 3000) ? readFileSync(app.log, "utf8") : "", "-A\nopen=Open\nwidecode: permission\nBash ls: allow it?\n");
  ok("a click runs onClick", await until(() => existsSync(clicked), 3000));
  ok("and shows its request in the chat", await until(() => app.w.chat.pane.panel.item?.requestId === "req-1", 3000) && app.w.host.screen.active.peek() === "chat");
  closeWidecode(app.w);

  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
