// ffi: @lightstart/plugins/native/ffi.json
// The approval mode: the pure decision (each mode, a call's kind, paths inside and outside the
// folder), the mode kept in the state file across a run, and Shift+Tab cycling ask, auto, plan and
// full through the chat plugin (the fake ACP agent offers a plan mode).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, pathsOf } from "../plugins/acp/approval.ts";
import { KeyEvent } from "@lightstart/light/native/tui";
import type { Lightcode } from "../src/compose.ts";
import { Store } from "../src/services/store.ts";
import { closeLightcode, openLightcode } from "./support/app.ts";
import { done, eq } from "@lightstart/test/assert.ts";

const folder = "/work/project";

const main = async (): Promise<void> => {
  eq("ask: a read inside still asks", approve("ask", "read", [folder + "/a.txt"], folder), "ask");
  eq("ask: an edit outside asks", approve("ask", "edit", ["/etc/passwd"], folder), "ask");
  eq("full: a shell command is allowed", approve("full", "execute", [], folder), "allow");
  eq("full: a path outside is allowed", approve("full", "edit", ["/etc/passwd"], folder), "allow");
  eq("plan: an edit inside is rejected", approve("plan", "edit", [folder + "/a.txt"], folder), "reject");
  eq("plan: no paths is rejected", approve("plan", "read", [], folder), "reject");
  eq("auto: a read inside is allowed", approve("auto", "read", [folder + "/a.txt"], folder), "allow");
  eq("auto: a search inside is allowed", approve("auto", "search", [folder + "/src"], folder), "allow");
  eq("auto: a think is allowed", approve("auto", "think", [], folder), "allow");
  eq("auto: an edit inside is allowed", approve("auto", "edit", [folder + "/a.txt"], folder), "allow");
  eq("auto: the folder itself is inside", approve("auto", "read", [folder], folder), "allow");
  eq("auto: a relative path is inside", approve("auto", "read", ["a.txt"], folder), "allow");
  eq("auto: an edit outside asks", approve("auto", "edit", ["/etc/passwd"], folder), "ask");
  eq("auto: one path outside asks", approve("auto", "edit", [folder + "/a.txt", "/etc/passwd"], folder), "ask");
  eq("auto: a relative path out of the folder asks", approve("auto", "read", ["../other/a.txt"], folder), "ask");
  eq("auto: a home path asks", approve("auto", "read", ["~/a.txt"], folder), "ask");
  eq("auto: a path with .. inside still inside is allowed", approve("auto", "read", [folder + "/src/../a.txt"], folder), "allow");
  eq("auto: a shell command asks", approve("auto", "execute", [], folder), "ask");
  eq("auto: a fetch asks", approve("auto", "fetch", [folder + "/a.txt"], folder), "ask");
  eq("auto: an unknown kind asks", approve("auto", "mystery", [folder + "/a.txt"], folder), "ask");
  eq("an unknown mode asks", approve("yolo", "read", [folder + "/a.txt"], folder), "ask");
  eq("a call's paths: its locations and its input's path fields", pathsOf([folder + "/a.txt"], { filePath: folder + "/b.txt", paths: [folder + "/c.txt"], command: "rm" }).join(","), folder + "/a.txt," + folder + "/b.txt," + folder + "/c.txt");

  // The mode is kept across a run.
  const home = mkdtempSync(join(tmpdir(), "lightcode-approval-home-"));
  const dir = mkdtempSync(join(tmpdir(), "lightcode-approval-"));
  const first = await openLightcode({ folder: dir, state: new Store(home).stateFile() });
  eq("a new run asks", first.host.approval.approval.peek(), "ask");
  first.host.approval.set("auto");
  eq("set, the signal says so", first.host.approval.approval.peek(), "auto");
  closeLightcode(first);
  const next = await openLightcode({ folder: dir, state: new Store(home).stateFile() });
  eq("the next run starts on the mode kept", next.host.approval.approval.peek(), "auto");
  closeLightcode(next);
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });

  // Shift+Tab cycles through the chat plugin, the fake ACP agent offering a plan mode.
  const fake = join(process.cwd(), "test/fake-acp.mjs");
  const chatFolder = mkdtempSync(join(tmpdir(), "lightcode-approval-chat-"));
  const w = await openLightcode({
    folder: chatFolder,
    plugins: { acp: { agents: { fake: { name: "Fake", command: ["node", fake] } } } },
    before: (app: Lightcode) => {
      app.host.session.agentId.value = "fake";
    },
  });
  w.host.conversation.prepare();
  const press = (): void => {
    w.shell.handleKey(new KeyEvent("tab", "", false, false, true));
  };
  const seen = [w.host.approval.approval.peek()];
  for (let i = 0; i < 4; i++) {
    press();
    seen.push(w.host.approval.approval.peek());
  }
  eq("Shift+Tab cycles ask, auto, plan, full, ask", seen.join(","), "ask,auto,plan,full,ask");
  w.host.roles.chat.submit("/mode");
  eq("/mode says the mode and the cycle", w.host.screen.message.peek(), "mode: ask (Shift+Tab cycles ask, auto, plan, full)");
  w.host.roles.chat.submit("/mode full");
  eq("/mode sets one", w.host.approval.approval.peek(), "full");
  w.host.roles.chat.submit("/mode yolo");
  eq("/mode refuses another", w.host.screen.message.peek(), "/mode takes ask, auto, plan or full (now full)");
  closeLightcode(w);
  rmSync(chatFolder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
