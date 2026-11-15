// ffi: @light/plugins/native/ffi.json
// widecode's plugins as config.json switches them: with languages off nothing is colored; with
// agents off there is no Agents tab; with git off there is no Git tab, no b and no compare row;
// with changes off the band is the status table alone. A plugin from outside the built-in list adds
// a command, a key, a status segment and a tab; one whose requirement is off is left out and
// reported. The code column's wrap and the Files switch are kept between runs; the code column
// comes back after /reload, the focus and the tab where they were; Ctrl+C in the Files tab quits;
// every built-in plugin answers its defaults for a new config.json.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { languageForFence, languageForPath } from "@lightstart/highlight";
import { Panel, SegmentContext, SegmentDef } from "../src/screen/contributions.ts";
import { Host } from "../src/controllers/host.ts";
import { Command } from "@light/kernel/commands.ts";
import { Action } from "@light/kernel/actions.ts";
import { Plugin } from "@light/kernel/plugin.ts";
import { NoStateFile } from "@light/kernel/settings.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { composeWidecode, createWidecode, Widecode } from "../src/compose.ts";
import { Caret, Clip, DEFAULT_STYLE, KeyEvent, Screen, TRoot, frames, layout, mount, paint, unmount } from "@lightstart/light/native/tui";
import { Line, LineSource, Run } from "@light/ui/line-view.ts";
import { done, eq, ok } from "@light/test/assert.ts";
import { LANGUAGES } from "@lightstart/highlight/languages.ts";

const W = 200;
const H = 20;
const repo = mkdtempSync(join(tmpdir(), "widecode-plugins-"));
const git = (args: string[]): void => {
  const all = ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main"];
  for (const a of args) all.push(a);
  spawnSync("git", all, { encoding: "utf8" });
};
writeFileSync(join(repo, "a.ts"), "const a = 1;\n");
git(["init", "-q"]);
git(["add", "."]);
git(["commit", "-qm", "init"]);
writeFileSync(join(repo, "a.ts"), "const a = 2;\n");

class NotesSource extends LineSource {
  count(): number {
    return 1;
  }

  line(_index: number, _width: number): Line {
    const l = new Line();
    l.add(" a note", "");
    return l;
  }
}

class NotesPanel extends Panel {
  constructor() {
    super("notes", "Notes", 9);
    this.view.setSource(new NotesSource());
  }

  override info(): Run[] {
    return [new Run(" 1 note", "gray")];
  }
}

/** A plugin from outside the built-in list: a command, a key, a segment, a tab. */
class Extra extends Plugin {
  readonly host: Host;
  heard: string[] = [];

  constructor(host: Host, requires: string[]) {
    super("extra", requires);
    this.host = host;
  }

  override activate(): void {
    const h = this.host;
    h.kernel.commands.add(new Command("/hello", "", "say hello", this.id, (arg: string) => h.screen.tell("hello " + arg)));
    h.kernel.actions.add(
      new Action("extra.hello", "code", "z hello", ["char:z"], this.id, (_key: KeyEvent, _count: number) => {
        this.heard.push("z");
        return true;
      }),
    );
    h.screen.segments.add(new SegmentDef("hello", this.id, (_ctx: SegmentContext) => [new Run("hello!", "#61afef")], null));
    h.screen.addPanel(this.id, new NotesPanel());
  }
}

const main = async (): Promise<void> => {
  const ws = await openWorkspace(repo, 100);
  const root = new TRoot();
  const screen = (_w: Widecode): string[] => {
    for (let i = 0; i < 3; i++) {
      frames.flush();
      layout(root, W, H, DEFAULT_STYLE);
    }
    const s = new Screen(W, H);
    paint(root, s, new Clip(0, 0, W, H), DEFAULT_STYLE, new Caret(), null);
    return s.text().split("\n");
  };
  const show = async (w: Widecode): Promise<string[]> => {
    w.shell.resize(W);
    mount(w.shell, root);
    await w.host.load();
    return screen(w);
  };
  const end = (w: Widecode): void => {
    unmount(w.shell);
    w.host.kernel.stop();
  };
  /** The side tabs: the files column's top edge, as the row reads. */
  const tabs = (w: Widecode, shown: string[]): string => {
    const x = w.shell.xOf("side");
    // Row 2: the columns start under the menu bar and its margin.
    return shown[2].slice(x, x + w.shell.widthOf("side")).replace(/[▏▕]/g, " ").trim().replace(/\s+/g, " ");
  };
  const press = (w: Widecode, name: string, text: string): boolean => w.shell.handleKey(new KeyEvent(name, text, false, false, false));

  let w = createWidecode(ws, new Conversation(ws.folder), JSON.parse('{"languages": false}'));
  ok("languages off: no language, so nothing is colored", languageForPath("a.ts") === "" && !w.host.kernel.has("languages"));
  end(w);

  w = createWidecode(ws, new Conversation(ws.folder), JSON.parse('{"agents": false}'));
  let lines = await show(w);
  eq("agents off: the side tabs stay on the top edge", tabs(w, lines), "Files 1 Sessions Git");
  ok("agents off: no Agents tab, nothing opens a subagent", !w.host.screen.panels.some((p) => p.id === "agents") && w.host.screen.panelsIn("tools").map((p) => p.id).join(" ") === "calls available");
  end(w);

  w = createWidecode(ws, new Conversation(ws.folder), JSON.parse('{"git": false}'));
  lines = await show(w);
  eq("git off: no Git tab", w.host.screen.panelsIn("side").map((p) => p.id).join(" ") + " · " + tabs(w, lines), "files sessions peers skills · Files 1 Sessions");
  w.host.screen.showPanel("files");
  ok("no b, no compare row", !press(w, "char", "b") && !lines.some((l) => l.includes(" vs  HEAD ")));
  ok("the languages are back with their plugin", languageForPath("a.ts") === "typescript");
  ok("the tests' languages are the plugin's", LANGUAGES.every((l) => l.extensions.every((e) => languageForPath("x." + e) === l.id) && l.fences.every((f) => languageForFence(f) === l.id)));
  end(w);

  w = createWidecode(ws, new Conversation(ws.folder), JSON.parse('{"changes": false}'));
  lines = await show(w);
  ok("changes off: the band is the status table alone", !w.host.screen.band.some((b) => b.id === "changes") && !lines.some((l) => l.includes("1 file  +1 −1")));
  w.host.screen.focus("code");
  ok("and [ is no key of anyone's", !press(w, "char", "["));
  end(w);

  w = composeWidecode(ws, new Conversation(ws.folder));
  const extra = new Extra(w.host, ["git"]);
  w.start(JSON.parse('{"status": {"lines": [["hello", "note"]]}}'), new NoStateFile(), [extra]);
  lines = await show(w);
  ok("an extra plugin's tab joins the column", w.host.screen.panelsIn("side").map((p) => p.id).includes("notes"));
  ok("its segment in the status table the config lays out", lines.some((l) => l.includes(" hello! │ ")));
  w.host.roles.chat.submit("/hello there");
  eq("its command", w.host.screen.message.peek(), "hello there");
  w.host.screen.focus("code");
  ok("its key, in its scope", press(w, "char", "z") && extra.heard.join("") === "z");
  ok("its hint among the code column's", w.host.screen.hints().includes("z hello"));
  w.host.screen.showPanel("notes");
  lines = screen(w);
  ok("its tab shows its rows and info", lines.some((l) => l.includes(" 1 note")) && lines.some((l) => l.includes(" a note")));
  end(w);

  w = composeWidecode(ws, new Conversation(ws.folder));
  const orphan = new Extra(w.host, ["git"]);
  w.start(JSON.parse('{"git": false}'), new NoStateFile(), [orphan]);
  eq("one whose requirement is off is left out, and said so", String(w.host.kernel.has("extra")) + " | " + w.host.kernel.problems.join("; "), "false | extra: needs git, which is off");
  end(w);

  const state = new NoStateFile();
  w = composeWidecode(ws, new Conversation(ws.folder));
  w.start(null, state, []);
  await show(w);
  w.host.screen.focus("code");
  press(w, "char", "w");
  w.host.screen.showPanel("files");
  press(w, "char", "c");
  end(w);
  w = composeWidecode(ws, new Conversation(ws.folder));
  w.start(null, state, []);
  // The Files tab's switch: "Changed" is the bold side.
  const info = w.host.screen.findPanel("files")?.info() ?? [];
  ok("wrap and the Files switch are kept for the next run", w.code.pane.wrap.peek() && info.length === 3 && info[2].bold);
  end(w);

  // The code column is a native widget its JS plugin mounts: /reload mounts it again.
  w = createWidecode(ws, new Conversation(ws.folder), null);
  await show(w);
  await w.code.load("a.ts");
  w.host.screen.showPanel("git");
  w.host.roles.chat.submit("/reload");
  await w.code.load("a.ts");
  lines = screen(w);
  const kept = w.host.screen.active.peek() + " " + w.host.screen.shownIn("side");
  w.host.screen.focus("code");
  ok("after /reload the code column is back, its keys too, the focus and tab where they were", kept === "side git" && w.host.screen.columns.map((c) => c.id).join(",") === "chat,tools,side,code" && w.host.roles.code.path() === "a.ts" && lines.some((l) => l.includes(" a.ts M")) && press(w, "char", "w") && w.code.pane.wrap.peek());
  // A tab's own keys are plain ones: Ctrl+C there still quits.
  let quits = 0;
  w.host.onQuit = () => quits++;
  w.host.screen.showPanel("files");
  w.shell.handleKey(new KeyEvent("char", "c", true, false, false));
  const switchInfo = w.host.screen.findPanel("files")?.info() ?? [];
  ok("Ctrl+C in the Files tab quits, the switch untouched", quits === 1 && switchInfo.length === 3 && !switchInfo[2].bold);
  end(w);

  const defaults = composeWidecode(ws, new Conversation(ws.folder)).defaults();
  eq("every built-in plugin answers its defaults", defaults.map((d) => d.id + (d.value === true ? "" : "*")).join(" "), "acp* agents alerts* ask* box changes chat claude* claude-rules code dirty-repo-guard emacs files git git-checkpoint harness inline-bash languages menus models* peers* permission-gate* pi* protected-paths* sessions* skills status* todo tools tools-switch vi");
  ws.close();
  rmSync(repo, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
