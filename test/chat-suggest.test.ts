// Completion's matching: the @token the caret is in, and the best few paths for it (a name that
// starts with the query, then a path, then one holding it, then holding its letters in order),
// without scoring the whole list twice.
import { atToken, matchPaths } from "../src/chat/suggest.ts";
import { done, eq, ok } from "@lightstart/test/assert.ts";

const tok = atToken("look at @sr", 11);
ok("the @token at the caret", tok !== null && tok.start === 8 && tok.query === "sr");
ok("an @ inside a word is not a token", atToken("mail@x", 6) === null);
ok("a space ends it", atToken("@app.js now", 9) === null);

const paths = ["src/app.ts", "x/app.ts", "app.ts", "docs/readme.md"];
eq("best first: the name, then the shorter path", matchPaths(paths, "app", 3).join(","), "app.ts,x/app.ts,src/app.ts");
eq("at most the asked for", matchPaths(paths, "app", 2).join(","), "app.ts,x/app.ts");
eq("empty query ranks by path", matchPaths(["b", "a", "c"], "", 2).join(","), "a,b");
eq("letters in order count", matchPaths(paths, "rdm", 1).join(","), "docs/readme.md");
eq("nothing for a query no path holds", matchPaths(paths, "zzz", 3).join(","), "");

done();
