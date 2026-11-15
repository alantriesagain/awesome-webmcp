// node-only
// Leaving: the records are flushed before the exit callback runs, and no records leaves at once.
import { flushBeforeExit, QuitFlusher } from "../src/quit.ts";
import { done, eq } from "@lightstart/test/assert.ts";

let waited = 0;
const records = new QuitFlusher(() => {
  waited++;
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
});
let left = 0;
flushBeforeExit(records, () => {
  left++;
});
eq("the flush starts before leaving", String(waited) + " " + String(left), "1 0");
await new Promise<void>((resolve) => setTimeout(resolve, 1));
eq("the exit callback runs after it", String(waited) + " " + String(left), "1 1");
let immediate = 0;
flushBeforeExit(null, () => {
  immediate++;
});
eq("without records it leaves at once", String(immediate), "1");
done();
