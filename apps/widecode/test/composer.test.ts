// ffi: @light/plugins/native/ffi.json
// The chat's composer, in the app: Ctrl+K kills to the line's end and puts what it killed on the
// clipboard (here OSC 52, captured), and at a line's end joins the next without copying anything.
// Alt+←/→ (and Alt+b, Alt+f) move by a word, punctuation between words, across a line's end;
// Ctrl+D deletes forward, at a line's end joining the next. Ctrl+C clears the message and quits only
// when it is empty; Ctrl+←/→ move by a word while there is text and switch columns when there is
// none; Ctrl+Backspace deletes the word before.
// ↑ and ↓ walk the messages written in the folder (kept in its .widecode/history.jsonl), the draft
// coming back after the newest; on a message of several lines they move between its lines first;
// typing over a recalled message makes it the draft; the @ strip's ↑↓ come first while it shows. A
// command typed lists the commands its name starts, Enter takes one; then its argument's values
// (Claude Code's models: the one it runs on, then the config's), and Enter runs it with the one chosen.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { attachImages } from "@widecode/conversation/attach.ts";
import { osc52 } from "@light/ui/clipboard.ts";
import { Store } from "../src/services/store.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { createWidecode, Widecode } from "../src/compose.ts";
import { DEFAULT_STYLE, frames, KeyEvent, layout, mount, setValue, TRoot, unmount } from "@bootstrapp/light/native/tui";
import { done, eq, ok } from "@light/test/assert.ts";

/** A key as the terminal delivers it: the shell's actions, the composer's editing among them. */
const key = (w: Widecode, name: string, text: string, ctrl: boolean, alt = false): void => {
  w.shell.handleKey(new KeyEvent(name, text, ctrl, alt, false));
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-composer-"));
  writeFileSync(join(folder, "alpha.txt"), "a\n");
  const home = mkdtempSync(join(tmpdir(), "widecode-composer-home-"));
  const ws = await openWorkspace(folder, 100);
  const w = createWidecode(ws, new Conversation(ws.folder), null);
  await w.host.useStore(new Store(home));
  const root = new TRoot();
  w.shell.resize(160);
  mount(w.shell, root);
  await w.host.load();
  frames.flush();
  layout(root, 160, 30, DEFAULT_STYLE);
  const copied: string[] = [];
  w.host.screen.clipboard.mode = "osc52";
  w.host.screen.clipboard.onWrite = (text: string) => copied.push(text);
  const input = w.chat.pane.input;
  w.host.screen.focus("chat");

  setValue(input, "first line\nsecond");
  input.row = 0;
  input.col = 5;
  key(w, "char", "k", true);
  eq("Ctrl+K kills to the line's end", JSON.stringify(input.lines), '["first","second"]');
  eq("and puts it on the clipboard", copied.join("|"), osc52(" line"));
  key(w, "char", "k", true);
  eq("at the line's end it joins the next, copying nothing", JSON.stringify(input.lines) + " " + String(copied.length), '["firstsecond"] 1');

  setValue(input, "git commit -m fix_bug\nnext");
  input.row = 0;
  input.col = 21;
  const at: string[] = [];
  for (const k of ["left", "left", "left", "right", "right"]) {
    key(w, k, "", false, true);
    at.push(String(input.row) + ":" + String(input.col));
  }
  eq("Alt+←/→ move by a word, punctuation between words", at.join(" "), "0:14 0:12 0:4 0:10 0:13");
  key(w, "char", "b", false, true);
  key(w, "char", "b", false, true);
  key(w, "char", "f", false, true);
  eq("and Alt+b, Alt+f", String(input.row) + ":" + String(input.col), "0:10");
  input.col = 21;
  key(w, "right", "", false, true);
  eq("across a line's end", String(input.row) + ":" + String(input.col), "1:0");
  input.row = 0;
  input.col = 10;
  key(w, "char", "d", true);
  eq("Ctrl+D deletes forward", input.lines[0], "git commit-m fix_bug");
  input.col = 20;
  key(w, "char", "d", true);
  eq("at a line's end it joins the next", JSON.stringify(input.lines), '["git commit-m fix_bugnext"]');

  // Messages written: local commands, so nothing starts Claude.
  const send = (text: string): void => {
    setValue(input, text);
    key(w, "enter", "", false);
    frames.flush();
  };
  for (const text of ["/effort low", "/effort max", "/help"]) send(text);
  const log = join(folder, ".widecode", "history.jsonl");
  eq("kept in the folder's .widecode/history.jsonl, ignored by git", String(existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0) + " " + String(existsSync(join(folder, ".widecode", ".gitignore"))), "3 true");
  setValue(input, "my draft");
  const walk: string[] = [];
  for (const k of ["up", "up", "up", "up", "down", "down", "down"]) {
    key(w, k, "", false);
    walk.push(input.value());
  }
  eq("↑ walks back, stops at the oldest; ↓ comes forward to the draft", walk.join(" | "), "/help | /effort max | /effort low | /effort low | /effort max | /help | my draft");
  setValue(input, "one\ntwo");
  key(w, "up", "", false);
  eq("on a message of several lines ↑ moves up a line first", String(input.row) + " " + input.value(), "0 one\ntwo");
  key(w, "up", "", false);
  eq("then walks", input.value(), "/help");
  key(w, "char", "!", false);
  frames.flush();
  key(w, "down", "", false);
  eq("typing over a recalled message makes it the draft", input.value(), "/help!");
  setValue(input, "look at @alp");
  frames.flush();
  const before = input.value();
  key(w, "up", "", false);
  eq("the @ strip's ↑ comes first while it shows", String(w.chat.pane.strip.visible) + " " + input.value(), "true " + before);

  const listed = (): string => w.chat.pane.strip.items.peek().map((s) => s.value + (s.detail.length > 0 ? " (" + s.detail + ")" : "")).join(",");
  setValue(input, "/mo");
  frames.flush();
  eq("a command's name as it is typed", w.chat.pane.strip.items.peek().map((s) => s.value).join(","), "/model");
  key(w, "enter", "", false);
  frames.flush();
  eq("Enter takes it and waits for its value, listing them", input.value() + "|" + listed(), "/model |opus[1m] (now),fable[1m] (F5)");
  setValue(input, "/model fa");
  frames.flush();
  eq("typing narrows them", listed(), "fable[1m] (F5)");
  key(w, "enter", "", false);
  frames.flush();
  eq("Enter runs it with the one chosen", w.host.conversation.modelName + "|" + input.value(), "fable[1m]|");
  setValue(input, "/effort h");
  frames.flush();
  key(w, "enter", "", false);
  eq("an effort the same way", w.host.conversation.effort, "high");

  let quits = 0;
  w.host.onQuit = () => {
    quits++;
  };
  setValue(input, "a message half written");
  key(w, "char", "c", true);
  eq("Ctrl+C with text clears the message and does not quit", input.value() + " " + String(quits), " 0");
  key(w, "char", "_", true);
  eq("the clear undoes", input.value(), "a message half written");
  setValue(input, "");
  key(w, "char", "c", true);
  eq("Ctrl+C with the message empty quits", String(quits), "1");
  setValue(input, "alpha beta gamma");
  input.col = 16;
  key(w, "left", "", true);
  key(w, "left", "", true);
  eq("Ctrl+← with text moves by a word, the column stays", String(input.col) + " " + w.host.screen.active.peek(), "6 chat");
  key(w, "right", "", true);
  ok("Ctrl+→ too", input.col > 6 && input.col <= 11);
  setValue(input, "");
  key(w, "right", "", true);
  eq("Ctrl+→ with the message empty switches columns", w.host.screen.active.peek() === "chat" ? "stayed" : "moved", "moved");
  w.host.screen.focus("chat");
  setValue(input, "remove the last word");
  key(w, "backspace", "", true);
  eq("Ctrl+Backspace deletes the word before", input.value(), "remove the last ");

  // A pasted image path becomes a chip while composing; the reference goes back in when it is sent.
  const shot = join(folder, "shot.png");
  writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  setValue(input, "");
  key(w, "paste", shot, false);
  eq("a pasted path becomes an [Image #N] chip", input.value(), "[Image #1]");
  const expanded = w.chat.pane.composer.expand(input.value());
  eq("and goes back to its path on send", expanded, shot);
  const attached = attachImages(expanded + " look", folder);
  eq("so the send attaches it", String(attached.images.length) + " " + attached.text, "1 [Image #1] look");
  const spaced = join(folder, "a copied shot.png");
  writeFileSync(spaced, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  setValue(input, "");
  key(w, "paste", spaced, false);
  eq("a copied path with spaces becomes a chip too", input.value(), "[Image #2]");
  const quoted = w.chat.pane.composer.expand(input.value());
  eq("a spaced path is quoted on send, so it reads as one reference", quoted, "'" + spaced + "'");
  const beside = attachImages("what is this " + quoted, folder);
  eq("so the image attaches beside other text", String(beside.images.length) + " " + beside.text, "1 what is this [Image #1]");
  const code = join(folder, "code.ts");
  writeFileSync(code, "const x = 1;\n");
  setValue(input, "");
  key(w, "paste", code, false);
  eq("a pasted non-image becomes a [File #N] chip", input.value(), "[File #1]");
  eq("and goes back to its path on send", w.chat.pane.composer.expand(input.value()), code);

  unmount(w.shell);
  w.host.kernel.stop();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : "error"));
  process.exit(1);
});
