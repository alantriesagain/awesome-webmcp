// node-only
// What @widecode/conversation reaches at runtime from its exports: lib, the agent's status, markdown (and its tokenizers), the palette, light's signals and lines: nothing of the engine's host or templates.
import { done, eq, ok } from "@light/test/assert.ts";
import { packagesLine, reachOf } from "@light/test/imports.ts";

const reach = reachOf(".");
eq("it reaches " + "@bootstrapp/light, @light/highlight, @light/lib, @light/markdown, @light/ui, @widecode/agent", packagesLine(reach, "@widecode/conversation"), "@bootstrapp/light, @light/highlight, @light/lib, @light/markdown, @light/ui, @widecode/agent");
ok("and no app", !Array.from(reach.packages).some((p) => !p.startsWith("@")));
ok("it does not reach @bootstrapp/light's html", !reach.reaches("@bootstrapp/light", "html"));
ok("it does not reach @bootstrapp/light's native/tui/host.ts", !reach.reaches("@bootstrapp/light", "native/tui/host.ts"));
ok("it reaches @bootstrapp/light's signals", reach.reaches("@bootstrapp/light", "signals"));
ok("it reaches @bootstrapp/light's native/tui/lines.ts", reach.reaches("@bootstrapp/light", "native/tui/lines.ts"));
done();
