// node-only
// What @widecode/harness reaches at runtime from its exports: lib and the workspace's file lister.
import { done, eq, ok } from "@light/test/assert.ts";
import { packagesLine, reachOf } from "@light/test/imports.ts";

const reach = reachOf(".");
eq("it reaches " + "@light/lib, @light/workspace", packagesLine(reach, "@widecode/harness"), "@light/lib, @light/workspace");
ok("and no app", !Array.from(reach.packages).some((p) => !p.startsWith("@")));
done();
