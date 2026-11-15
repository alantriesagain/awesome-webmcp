// Moving a column among the others, and where a saved order puts the columns when they are added:
// a moved column keeps the new order for the next run, an unknown id or the position it is at does
// nothing, and a saved order places the columns it names while the others stay.
import { Kernel } from "@light/kernel/kernel.ts";
import { View } from "@lightstart/light/native/tui";
import { Column } from "../contributions.ts";
import { ScreenController, applySavedOrder, columnOrderOf } from "../screen.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const column = (id: string, order: number): Column => new Column(id, id, order, new View(), () => 0, 0, 0, null, null);
const ids = (screen: ScreenController): string => screen.columns.map((c) => c.id).join(",");

const screen = new ScreenController(new Kernel(), "a");
screen.addColumn("p", column("a", 0));
screen.addColumn("p", column("b", 1));
screen.addColumn("p", column("c", 2));
eq("columns start in their order", ids(screen), "a,b,c");
ok("moving one forward answers true", screen.moveColumn("c", 0));
eq("forward", ids(screen), "c,a,b");
ok("moving one backward answers true", screen.moveColumn("c", 2));
eq("backward", ids(screen), "a,b,c");
ok("an unknown id or the same position does nothing", !screen.moveColumn("x", 0) && !screen.moveColumn("a", 0));
eq("and the order is as it was", ids(screen), "a,b,c");
screen.moveColumn("b", 2);
eq("the saved order follows the move", screen.columnOrder().join(","), "a,c,b");

const placed = [column("a", 0), column("b", 1), column("c", 2), column("d", 3)];
applySavedOrder(placed, ["c", "x", "a"]);
eq("a saved order puts the columns it names, skipping a missing one", placed.map((c) => c.id).join(","), "c,a,b,d");
eq("a saved order is read as its string ids, each once", columnOrderOf(JSON.parse('["c","x","c",3]')).join(","), "c,x");

const later = new ScreenController(new Kernel(), "a");
later.setColumnOrder(columnOrderOf(JSON.parse('["c","a"]')));
later.addColumn("p", column("a", 0));
later.addColumn("p", column("b", 1));
later.addColumn("p", column("c", 2));
eq("columns added after a saved order are placed by it", ids(later), "c,a,b");

done();
