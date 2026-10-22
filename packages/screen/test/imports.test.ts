// node-only
// What @widecode/screen reaches at runtime from its exports: light, the agent's status, the kernel, lib, ui.
import { done, eq, ok } from "@light/test/assert.ts";
import { packagesLine, reachOf } from "@light/test/imports.ts";

const reach = reachOf(".");
eq("it reaches " + "@bootstrapp/light, @light/kernel, @light/lib, @light/ui, @widecode/agent", packagesLine(reach, "@widecode/screen"), "@bootstrapp/light, @light/kernel, @light/lib, @light/ui, @widecode/agent");
ok("and no app", !Array.from(reach.packages).some((p) => !p.startsWith("@")));
done();
