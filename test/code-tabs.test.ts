// The code column's tabs without a screen: Code first and never closed, an item tab opened beside
// it, a repeated id focused instead of added again, a press on a label showing it and one on its
// last two cells closing it, and the tab before a close shown.
import { CodeTab, CodeTabHost } from "../src/code/tabs.ts";
import { View } from "@lightstart/light/native/tui";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const host = new CodeTabHost(new View());
const ids = (): string => host.labels().join("|");
const active = (): string => host.active().id;

eq("only Code is open at first", ids(), "Code");
eq("and it is shown", String(host.activeIndex()) + " " + active(), "0 code");

const alpha = new CodeTab("call-a", "Alpha", true, new View());
host.open(alpha);
eq("an opened tab is added after Code and shown", ids(), "Code|Alpha ×");
eq("with its index and view active", String(host.activeIndex()) + " " + active(), "1 call-a");

host.open(new CodeTab("call-a", "Alpha again", true, new View()));
eq("the same id is focused, not added twice", ids(), "Code|Alpha ×");

host.open(new CodeTab("call-b", "Beta", true, new View()));
eq("a second item goes after the first", ids(), "Code|Alpha ×|Beta ×");
eq("and is shown", active(), "call-b");

// The first tab starts at column 0: " Code " is 6 cells, " Alpha × " 9, so Beta spans 15..24.
host.press(2, 0, 24);
eq("a press on the title shows the tab", active(), "call-b");
host.press(0, 1, 6);
eq("a press on Code shows Code", active(), "code");
host.press(2, 23, 24);
eq("a press on the last two cells closes the tab, the one before it shown", ids() + " " + active(), "Code|Alpha × call-a");
host.press(1, 1, 15);
host.press(1, 14, 15);
eq("the only item closes back to Code", ids() + " " + active(), "Code code");

const long = new CodeTab("call-long", "x".repeat(30), true, new View());
host.open(long);
eq("a closable label is clipped to 24 cells before its close mark", host.labels()[1], "x".repeat(23) + "… ×");
ok("Code does not close", (host.close(0), ids() + " " + active()) === "Code|" + "x".repeat(23) + "… × call-long");
host.close(1);
host.close(1);
eq("closing nothing leaves Code", ids() + " " + active(), "Code code");

done();
