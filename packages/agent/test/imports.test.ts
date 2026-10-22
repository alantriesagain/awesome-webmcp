// node-only
// What @widecode/agent reaches at runtime from its exports: lib alone.
import { done, eq, ok } from "@light/test/assert.ts";
import { packagesLine, reachOf } from "@light/test/imports.ts";

const reach = reachOf(".");
eq("it reaches " + "@light/lib", packagesLine(reach, "@widecode/agent"), "@light/lib");
ok("and no app", !Array.from(reach.packages).some((p) => !p.startsWith("@")));
done();
