// The menu bar's entries: they keep the order plugins gave them, move the signal the shell reads,
// and go when their plugin does.
import { Kernel } from "@lightstart/kernel/kernel.ts";
import { MenuEntry } from "../src/screen/contributions.ts";
import { ScreenController } from "../src/screen/screen.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const screen = new ScreenController(new Kernel(), "chat");
const add = (owner: string, menu: string, label: string, action: string, order: number): void => {
  screen.addMenuEntry(owner, new MenuEntry(menu, label, action, order));
};
const rows = (): string => screen.menuEntries.map((e) => e.owner + ":" + e.menu + ":" + e.label).join(",");

ok("entries start empty", screen.menuEntries.length === 0);
add("a", "File", "Open", "app.open", 30);
add("a", "File", "-", "", 20);
add("b", "Edit", "Undo", "app.undo", 10);
add("a", "View", "Zoom", "app.zoom", 40);
const moved = screen.menus.value;
eq("entries come in their order, whatever came first", rows(), "b:Edit:Undo,a:File:-,a:File:Open,a:View:Zoom");
ok("adding one moves the menus signal", moved > 0);
screen.removeOwner("a");
eq("removing an owner leaves only its entries out", rows(), "b:Edit:Undo");
ok("and moves the signal again", screen.menus.value > moved);
done();
