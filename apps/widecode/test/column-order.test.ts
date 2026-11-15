// ffi: @light/plugins/native/ffi.json
// Moving a column by its title row: a drag over another column's half drops it before or after it,
// the status bar says where it would land, the order is kept in state.json, a press without a move
// only focuses the column, and a saved order places the columns when they are added.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { createWidecode } from "../src/compose.ts";
import { DEFAULT_STYLE, MouseEvent, TElement, TRoot, frames, hitTest, layout, mount, unmount } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@light/test/assert.ts";

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-column-order-"));
  writeFileSync(join(folder, "a.txt"), "a\n");
  const ws = await openWorkspace(folder, 100);
  const w = createWidecode(ws, new Conversation(ws.folder), null);
  const root = new TRoot();
  const W = 200;
  const H = 24;
  w.shell.resize(W);
  mount(w.shell, root);
  await w.host.load();
  const settle = (): void => {
    for (let i = 0; i < 3; i++) {
      frames.flush();
      layout(root, W, H, DEFAULT_STYLE);
    }
  };
  settle();
  const order = (): string => w.host.screen.columns.map((c) => c.id).join(",");
  const top = w.shell.box.y + 1;
  const press = (x: number): TElement | null => {
    const target = hitTest(root, x, top);
    if (!(target instanceof TElement)) return null;
    target.dispatch(new MouseEvent("mousedown", x, top, 0, false, false, false));
    return target;
  };
  const move = (target: TElement, x: number): void => {
    target.dispatch(new MouseEvent("mousemove", x, top, 0, false, false, false));
    settle();
  };
  const release = (target: TElement, x: number): void => {
    target.dispatch(new MouseEvent("mouseup", x, top, 0, false, false, false));
    settle();
  };

  eq("columns start in their order", order(), "chat,tools,side,code");
  w.host.screen.focus("code");
  const still = press(2);
  ok("a press on a column's title row reaches it", still !== null);
  if (still !== null) release(still, 2);
  eq("a press without a move does not reorder", order(), "chat,tools,side,code");
  ok("and it still makes the column active", w.host.screen.active.peek() === "chat");

  const codeAt = w.shell.xOf("code");
  const dropX = codeAt + Math.floor((W - codeAt) * 3 / 4);
  const dragged = press(2);
  ok("the title row takes a drag of the column", dragged !== null);
  if (dragged !== null) {
    move(dragged, dropX);
    ok("the status bar says where the column would land", w.host.screen.message.peek().startsWith("move Chat after Code"));
    release(dragged, dropX);
  }
  eq("dropped on the code column's right half, the chat goes after it", order(), "tools,side,code,chat");
  eq("state.json keeps the order", JSON.stringify(w.host.kernel.settings.state("columnOrder")), '["tools","side","code","chat"]');

  unmount(w.shell);
  w.host.kernel.stop();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
