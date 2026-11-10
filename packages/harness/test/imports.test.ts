// node-only
// What @widecode/harness reaches at runtime from its exports: lib, the plugins engine, the workspace's file lister, the agent package's title prompt, the conversation package's shell splitter.
import { done, eq, ok } from "@light/test/assert.ts";
import { packagesLine, reachOf } from "@light/test/imports.ts";

const reach = reachOf(".");
eq("it reaches " + "@light/lib, @light/plugins, @light/workspace, @widecode/agent, @widecode/conversation", packagesLine(reach, "@widecode/harness"), "@light/lib, @light/plugins, @light/workspace, @widecode/agent, @widecode/conversation");
ok("and no app", !Array.from(reach.packages).some((p) => !p.startsWith("@")));
done();
