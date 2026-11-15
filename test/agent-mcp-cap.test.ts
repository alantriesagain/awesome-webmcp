// capResult: a tool's answer stays whole under its limit, keeps its head and tail with a paragraph
// between when over, and the middle is gone. The server applies it in `answer` (see mcp.ts).
import { capResult } from "../src/agent/index.ts";
import { done, eq, eqn, ok } from "@lightstart/test/assert.ts";

const short = "a tool's answer, well within the limit";
eq("under the limit: unchanged", capResult(short, 40000), short);

const atLimit = "x".repeat(40000);
eq("exactly at the limit: unchanged", capResult(atLimit, 40000), atLimit);

const head = "H".repeat(30000);
const middle = "M".repeat(12000);
const tail = "T".repeat(8000);
const long = head + middle + tail;
const note = "[widecode cut this result: it was 50000 characters, over the 40000 it returns to an agent. Ask again for less: a narrower question, a filter, fewer lines, or one part at a time.]";
const cut = capResult(long, 40000);
eq("over the limit: head, paragraph, tail", cut, head + "\n\n" + note + "\n\n" + tail);
eqn("its length: 30000 + 8000 + the paragraph between", cut.length, 30000 + 8000 + note.length + 4);
ok("the middle is gone", !cut.includes("M"));
ok("the paragraph opens as the card view looks for", cut.includes("[widecode cut this result:"));
ok("the numbers are the real ones", cut.includes("50000") && cut.includes("40000"));

done();
