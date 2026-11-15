// A prompt's "[Image #N]" chips: drawn in the link color, and the chip a press at a column lands on
// (the file a press opens). The prompt's own lines carry the files (PromptImages), so a press on a
// chip knows which to open.
import { Line } from "@lightstart/light/native/tui/lines.ts";
import { chipAt, promptLines } from "../src/conversation/render.ts";
import { palette } from "@light/ui/palette.ts";
import { done, eq } from "@light/test/assert.ts";

const line = new Line();
line.add("look at ", palette.promptFg);
line.add("[Image #1]", palette.link);
line.add(" and ", palette.promptFg);
line.add("[Image #2]", palette.link);
eq("no chip before the first (its prefix)", String(chipAt(line, 3)), "0");
eq("the first chip, under the column", String(chipAt(line, 10)), "1");
eq("the space between the chips", String(chipAt(line, 20)), "0");
eq("the second chip", String(chipAt(line, 24)), "2");
eq("past the last chip", String(chipAt(line, 200)), "0");

let fg = "";
for (const l of promptLines("see [Image #1] here", 40)) for (const r of l.runs) if (r.text === "[Image #1]") fg = r.fg;
eq("a drawn chip is in the link color", fg, palette.link);

done();
