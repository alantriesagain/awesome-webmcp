// Waiting on a condition in a test: until polls it every 10 ms and fails past UNTIL_MS, so a
// test whose agent, server or process never answers ends with a FAIL instead of waiting forever.
import { budget } from "@lightstart/test/assert.ts";

/** How long `until` waits before it fails: 30 s, scaled for a slower build as a speed check is. */
const UNTIL_MS = budget(30000);

/** Wait until `what` holds; past UNTIL_MS it fails. */
export const until = (what: () => boolean): Promise<void> =>
  new Promise<void>((settle, fail) => {
    const start = Date.now();
    const tick = (): void => {
      if (what()) settle();
      else if (Date.now() - start > UNTIL_MS) fail(new Error("until: still waiting after " + String(Math.round(UNTIL_MS / 1000)) + " s"));
      else setTimeout(tick, 10);
    };
    tick();
  });
