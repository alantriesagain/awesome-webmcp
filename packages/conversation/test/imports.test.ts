// node-only
// What @widecode/conversation reaches at runtime from its exports: lib, the agent's status, markdown (and its tokenizers), the palette, light's signals and lines: nothing of the engine's host or templates.
import { done, eq, ok } from "@light/test/assert.ts";
import { packagesLine, reachOf } from "@light/test/imports.ts";

const reach = reachOf(".");
eq("it reaches " + "@light/highlight, @light/lib, @light/markdown, @light/ui, @lightstart/light, @widecode/agent", packagesLine(reach, "@widecode/conversation"), "@light/highlight, @light/lib, @light/markdown, @light/ui, @lightstart/light, @widecode/agent");
ok("and no app", !Array.from(reach.packages).some((p) => !p.startsWith("@")));
ok("it does not reach @lightstart/light's html", !reach.reaches("@lightstart/light", "html"));
ok("it does not reach @lightstart/light's native/tui/host.ts", !reach.reaches("@lightstart/light", "native/tui/host.ts"));
ok("it reaches @lightstart/light's signals", reach.reaches("@lightstart/light", "signals"));
ok("it reaches @lightstart/light's native/tui/lines.ts", reach.reaches("@lightstart/light", "native/tui/lines.ts"));
done();
