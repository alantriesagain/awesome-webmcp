// Scripted checks run inside the app (light selftest <name>), each logging what it saw
// and quitting with 0 once done:
//   shell           open the first modified file, append a line, see one more change come back
//   fake | live-turn  send a message (to the fake CLI replaying a recorded turn, or to Claude) and
//                   see the answer on screen
//   fake-acp        the fake ACP agent asks permission for a call; allow it with a key, the call runs;
//                   then it asks a question over lightcode's MCP server (AskUser), answered with a key
//   harness         lightcode's own agent, the binary's `--harness` on its fake model: a turn runs a
//                   command and replies; then AskUser over lightcode's MCP server, answered with a key
//   live-acp        opencode over ACP runs a command and replies; the call and the reply on screen
//   live-acp-ask    opencode asks a question with lightcode's AskUser; answer it with a key; it repeats it
//   live-acp-plan   opencode in plan mode presents a plan with PresentPlan; approved, it leaves plan
//                   mode and the file changes
//   live-interrupt  start a 30 s Bash call, interrupt it, see "Interrupted", then a second turn
//   live-ask        Claude asks a question; answer it with a key; Claude repeats the answer
//   live-plan       plan mode on (Shift+Tab), approve the plan with Enter, the file changes
//   live-agent      a subagent reads a file; its card holds its own items
//   live-edit       Claude writes a new file and edits it; the code column follows it
//   live-quit       quit while a 30 s Bash call runs (the script then checks no CLI is left)
//   crash           an uncaught stack overflow once the screen is up: the log holds the error, the
//                   trail with the entry it happened in, the screen, and the exit (code 1)
//   open            /open a new folder: the app starts again over it, its file in the tree, the
//                   agent the same, and quits from there
//   segv            a native SIGSEGV once the screen is up: the crash report names what ran, the
//                   backtrace and the log, and the terminal comes back
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { triggerCrash } from "@lightstart/lib/crash.ts";
import { log, trail } from "@lightstart/lib/log.ts";
import { Lightcode } from "./compose.ts";
import { afterChange } from "./host/after-change.ts";
import { AGENT, Item, NOTICE, RUN, TEXT, TOOL, Turn } from "./conversation/model.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import { CodeFile } from "./code/diff.ts";
import { openFolder, quit } from "./host/actions.ts";

/** The turn's last text item, "" when none. */
const lastText = (turn: Turn): string => {
  const items = turn.body.children;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === TEXT) return items[i].text;
  return "";
};

export class Selftest {
  readonly name: string;
  readonly w: Lightcode;
  /** The painted screen's text, for checks against what the user would see. */
  screen: (() => string) | null = null;
  /** The app running now: after an /open, the one started again over the other folder. */
  current: () => Lightcode;
  private wroteAt = 0;
  private hunksBefore = -1;
  private step = 0;
  private finished = false;
  /** Stops the check of what the code column shows (the shell scenario). */
  private stopShown: (() => void) | null = null;

  constructor(name: string, w: Lightcode) {
    this.name = name;
    this.w = w;
    this.current = () => w;
  }

  /** Calls itself until the stack runs out (the crash scenario). */
  private recurse(n: number): number {
    return n > 1e12 ? n : this.recurse(n + 1) + 1;
  }

  start(): void {
    if (this.name === "segv") {
      setTimeout(() => {
        trail.enter("selftest", "segv");
        log("selftest segv: crashing now");
        triggerCrash(0);
      }, 500);
      return;
    }
    if (this.name === "crash") {
      setTimeout(() => {
        trail.enter("selftest", "crash");
        log("selftest crash: " + String(this.recurse(0)));
      }, 500);
      return;
    }
    setTimeout(() => this.fail("timed out at step " + String(this.step)), this.name.startsWith("live") ? 120000 : 30000);
    if (this.name === "shell") {
      this.stopShown = afterChange(this.w.host.screen.shown, () => this.shown(this.w.host.roles.code.file()));
      let first = "";
      for (const [path, mark] of this.w.host.folder.marks()) if (mark === "M" && (first.length === 0 || path < first)) first = path;
      if (first.length > 0) this.w.host.roles.code.open(first);
      else this.fail("no modified file");
      return;
    }
    if (this.name === "open") {
      void this.open();
      return;
    }
    this.w.host.hook("conversationChanged")?.on(() => this.conversation(), "selftest");
    if (this.name === "fake") this.w.host.roles.chat.submit("Reply with exactly the word PONG and nothing else.");
    else if (this.name === "fake-acp") this.w.host.roles.chat.submit("ask");
    else if (this.name === "harness") this.w.host.roles.chat.submit("run it");
    else if (this.name === "live-acp") this.w.host.roles.chat.submit("Use the bash tool to run exactly: ls. Then reply with exactly the word PONG.");
    else if (this.name === "live-turn") this.w.host.roles.chat.submit("Reply with exactly: PONG");
    else if (this.name === "live-interrupt") this.w.host.roles.chat.submit("Use the Bash tool to run exactly: python3 -c \"import time; time.sleep(30)\" and then say finished.");
    else if (this.name === "live-ask") this.w.host.roles.chat.submit("Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: Red and Blue. After I answer, reply with just the color I chose.");
    else if (this.name === "live-acp-ask") this.w.host.roles.chat.submit("Use the lightcode_AskUser tool to ask me which color I prefer, with exactly two options: Red and Blue. After I answer, reply with just the color I chose.");
    else if (this.name === "live-acp-plan") {
      // An ACP agent says its modes once its session is made: the mode goes with the first message.
      this.w.host.conversation.setMode("plan");
      this.w.host.roles.chat.submit("Plan how to add a line 'delta' at the end of README.md. Keep the plan to one sentence and present it with the lightcode_PresentPlan tool. After approval, make the change and say done.");
    }
    else if (this.name === "live-plan") {
      this.w.shell.handleKey(new KeyEvent("tab", "", false, false, true));
      this.w.host.roles.chat.submit("Plan how to add a line 'delta' at the end of README.md. Keep the plan to one sentence and present it with ExitPlanMode. After approval, make the change and say done.");
    } else if (this.name === "live-quit") this.w.host.roles.chat.submit("Use the Bash tool to run exactly: python3 -c \"import time; time.sleep(30)\" and then say finished.");
    else if (this.name === "live-edit") this.w.host.roles.chat.submit("Use the Write tool to create hello.txt containing exactly the line hi. Then use the Edit tool to change hi to bye in it. Then say done.");
    else if (this.name === "live-agent") this.w.host.roles.chat.submit("Use the Agent tool (subagent_type general-purpose, not in the background) to have a subagent read README.md and report its first line. Then tell me what it reported.");
    else this.fail("unknown selftest " + this.name);
  }

  /** /open a new folder holding one file, then read the app started again over it. */
  private async open(): Promise<void> {
    const folder = mkdtempSync(join(tmpdir(), "lightcode-selftest-open-"));
    writeFileSync(join(folder, "only.txt"), "one\n");
    const agent = this.w.host.session.agentId.peek();
    this.step = 1;
    await openFolder(folder);
    const now = this.current();
    this.step = 2;
    await now.host.session.load(now.host.folder, now.host.hooks);
    const files = now.host.folder.paths();
    // The new mount paints on its next frames.
    const screen = this.screen;
    let text = "";
    for (let i = 0; i < 40 && !text.includes("only.txt"); i++) {
      await new Promise<void>((settle) => setTimeout(settle, 50));
      text = screen !== null ? screen() : "";
    }
    log("selftest open: a new app " + String(now !== this.w) + "; folder " + String(now.host.workspace.folder === folder) + "; files=" + String(files.length) + "; same agent " + String(now.host.session.agentId.peek() === agent) + "; screen shows it " + String(text.includes("only.txt")));
    if (now !== this.w && now.host.workspace.folder === folder && files.length === 1 && text.includes("only.txt")) this.pass();
    else this.fail("the app over " + folder + " is not the one shown");
  }

  private shown(file: CodeFile): void {
    if (this.hunksBefore < 0) {
      this.hunksBefore = file.hunks.length;
      this.wroteAt = Date.now();
      appendFileSync(resolve(this.w.host.workspace.folder, file.path), "const added = true;\n");
      log("selftest appended a line to " + file.path);
    } else if (file.hunks.length > this.hunksBefore) {
      log("selftest change shown in " + String(Date.now() - this.wroteAt) + " ms");
      this.pass();
    }
  }

  private conversation(): void {
    const m = this.w.host.conversation.model;
    const last = m.turns.length > 0 ? m.turns[m.turns.length - 1] : null;
    if (last === null) return;
    if (this.name === "live-acp") {
      if (last.result === null || m.running) return;
      this.w.host.hook("conversationChanged")?.off("selftest");
      const ran = last.body.children.some((i: Item) => i.kind === TOOL && i.category === RUN && i.result !== null);
      setTimeout(() => {
        const screen = this.screen;
        const text = screen !== null ? screen() : "";
        log("selftest " + this.w.host.conversation.agent.name() + " turn ended: " + last.result!.subtype + "; a command ran: " + String(ran) + "; screen shows PONG: " + String(text.includes("PONG")));
        if (ran && text.includes("PONG")) this.pass();
        else this.fail(ran ? "PONG not on screen" : "no command ran");
      }, 100);
      return;
    }
    if (this.name === "fake" || this.name === "live-turn") {
      if (last.result === null) return;
      setTimeout(() => {
        const screen = this.screen;
        const text = screen !== null ? screen() : "";
        log("selftest turn ended: " + last.result!.subtype + "; screen shows PONG: " + String(text.includes("PONG")));
        if (text.includes("PONG")) this.pass();
        else this.fail("PONG not on screen");
      }, 100);
      this.w.host.hook("conversationChanged")?.off("selftest");
      return;
    }
    if (this.name === "harness") {
      const panel = this.w.chat.pane.panel;
      const idle = last.result !== null && !panel.active && !m.running && m.pending.length === 0;
      if (this.step === 0 && idle) {
        this.step = 1;
        const ran = last.body.children.some((i: Item) => i.kind === TOOL && i.category === RUN && i.result !== null && i.result.text.includes("selftest-ran"));
        setTimeout(() => {
          const screen = this.screen;
          const text = screen !== null ? screen() : "";
          log("selftest harness ran a command: " + String(ran) + "; screen shows PONG: " + String(text.includes("PONG")));
          if (!ran || !text.includes("PONG")) this.fail(ran ? "PONG not on screen" : "no command ran");
          else this.w.host.roles.chat.submit("ask");
        }, 100);
      } else if (this.step === 1 && panel.active) {
        this.step = 2;
        log("selftest panel open: " + (panel.item !== null ? panel.item.name : ""));
        setTimeout(() => this.w.shell.handleKey(new KeyEvent("char", "2", false, false, false)), 300);
      } else if (this.step === 2 && idle) {
        this.step = 3;
        const got = lastText(last).includes('"Which color?": Blue');
        log("selftest answered over MCP; the harness got Blue: " + String(got));
        if (got) this.pass();
        else this.fail("the answer did not reach the harness");
      }
      return;
    }
    const asking = this.name === "live-ask" || this.name === "live-acp-ask";
    const planning = this.name === "live-plan" || this.name === "live-acp-plan";
    if (asking || planning || this.name === "fake-acp") {
      const panel = this.w.chat.pane.panel;
      const press = (key: string): void => {
        setTimeout(() => this.w.shell.handleKey(new KeyEvent(key.length > 0 ? "char" : "enter", key, false, false, false)), 300);
      };
      if (this.step === 0 && panel.active) {
        this.step = 1;
        log("selftest panel open: " + (panel.item !== null ? panel.item.name : ""));
        // A question's second option (Blue), a plan approved, a permission's first option (Allow once).
        press(asking ? "2" : this.name === "fake-acp" ? "1" : "");
        return;
      }
      const idle = last.result !== null && !panel.active && !m.running && m.pending.length === 0;
      if (this.name === "fake-acp") {
        if (this.step === 1 && idle) {
          this.step = 2;
          const call = m.tool("call_ask");
          const said = call !== null && call.result !== null ? call.result.text : "";
          log("selftest allowed; the call said: " + said);
          if (said !== "removed") this.fail("the call did not run");
          else setTimeout(() => this.w.host.roles.chat.submit("question"), 100);
        } else if (this.step === 2 && panel.active) {
          this.step = 3;
          log("selftest panel open: " + (panel.item !== null ? panel.item.name : ""));
          press("2");
        } else if (this.step === 3 && idle) {
          this.step = 4;
          const got = lastText(last).includes('"Which color?": Blue');
          log("selftest answered over MCP; the agent got Blue: " + String(got));
          if (got) this.pass();
          else this.fail("the answer did not reach the agent");
        }
        return;
      }
      // A plan approved in an ACP agent's plan mode ends its turn first; a message then asks it to carry the plan out.
      if (this.step === 1 && idle) {
        this.step = 2;
        const said = lastText(last);
        if (asking) {
          log("selftest answered; " + this.w.host.conversation.agent.name() + " said: " + said.slice(0, 60));
          if (said.includes("Blue")) this.pass();
          else this.fail("the answer was not Blue");
        } else {
          const readme = readFileSync(resolve(this.w.host.workspace.folder, "README.md"), "utf8");
          log("selftest plan approved; mode " + m.permissionMode + "; README has delta: " + String(readme.includes("delta")));
          if (readme.includes("delta") && m.permissionMode !== "plan") this.pass();
          else this.fail("the plan was not carried out");
        }
      }
      return;
    }
    if (this.name === "live-quit") {
      if (this.step > 0) return;
      const bash = last.body.children.find((i) => i.kind === TOOL && i.category === RUN && i.result === null && i.input !== null);
      if (bash === undefined) return;
      this.step = 1;
      log("selftest Bash running; quitting");
      setTimeout(() => this.pass(), 500);
      return;
    }
    if (this.name === "live-edit") {
      if (last.result === null || this.step > 0) return;
      this.step = 1;
      setTimeout(() => {
        const shown = this.w.host.roles.code.path();
        const lines = this.w.host.roles.code.file().lines.map((l) => l.text).join("|");
        const mark = this.w.host.folder.markOf("hello.txt");
        log("selftest code shows " + shown + " [" + lines + "]; tree mark " + mark);
        if (shown === "hello.txt" && lines === "bye" && mark === "U") this.pass();
        else this.fail("the code column did not follow the edit");
      }, 1000);
      return;
    }
    if (this.name === "live-agent") {
      if (last.result === null) return;
      for (const t of m.turns)
        for (const i of t.body.children)
          if (i.kind === TOOL && i.category === AGENT && i.children.length > 0) {
            log("selftest the Agent card holds " + String(i.children.length) + " items; Claude said: " + lastText(last).slice(0, 60));
            this.pass();
            return;
          }
      this.fail("no Agent card with items");
      return;
    }
    if (this.name === "live-interrupt") {
      if (this.step === 0) {
        const bash = last.body.children.find((i) => i.kind === TOOL && i.category === RUN && i.result === null && i.input !== null);
        if (bash === undefined) return;
        this.step = 1;
        log("selftest Bash running; interrupting");
        setTimeout(() => this.w.host.conversation.interrupt(), 500);
      } else if (this.step === 1 && last.result !== null) {
        const interrupted = last.body.children.some((i) => i.kind === NOTICE && i.text === "Interrupted");
        log("selftest first turn ended: " + last.result.reason + "; interrupted notice: " + String(interrupted));
        if (!interrupted) {
          this.fail("no Interrupted notice");
          return;
        }
        this.step = 2;
        this.w.host.roles.chat.submit("Reply with exactly: OK");
      } else if (this.step === 2 && last.result !== null && last !== m.turns[0]) {
        log("selftest second turn ended: " + last.result.subtype);
        this.step = 3;
        this.pass();
      }
    }
  }

  private pass(): void {
    if (this.finished) return;
    this.finished = true;
    this.stopShown?.();
    log("selftest ok");
    quit();
  }

  private fail(why: string): void {
    if (this.finished) return;
    this.finished = true;
    this.stopShown?.();
    log("selftest failed: " + why);
    this.current().host.conversation.kill();
    process.exit(1);
  }
}
