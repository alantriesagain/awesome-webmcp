// The screen's registries: a later column or tab of the same id replaces the earlier one, and one
// owner's removal takes only its own.
import { Kernel } from "@lightstart/kernel/kernel.ts";
import { View } from "@lightstart/light/native/tui";
import { Column, Panel } from "../src/screen/contributions.ts";
import { ScreenController } from "../src/screen/screen.ts";
import { done, eq } from "@lightstart/test/assert.ts";

class Tab extends Panel {}

const kernel = new Kernel();
const screen = new ScreenController(kernel, "chat");
const column = (title: string): Column => new Column("chat", title, 0, new View(), () => 0, 0, 0, null, null);
screen.addColumn("a", column("One"));
screen.addColumn("b", column("Two"));
eq("a column of the same id replaces the earlier", String(screen.columns.length) + " " + screen.columns[0].title + " " + screen.columns[0].owner, "1 Two b");

screen.addPanel("a", new Tab("tab", "One", 0));
screen.addPanel("b", new Tab("tab", "Two", 1));
eq("a tab of the same id replaces the earlier", String(screen.panels.length) + " " + screen.panels[0].title + " " + screen.panels[0].owner, "1 Two b");
screen.removeOwner("b");
eq("removing the owner leaves nothing", String(screen.columns.length) + " " + String(screen.panels.length), "0 0");

done();
