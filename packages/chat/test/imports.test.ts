// node-only
// What @widecode/chat reaches at runtime from its exports: the code column's role and sources, the conversation, the screen, the kernel, ui, light.
import { done, eq, ok } from "@light/test/assert.ts";
import { packagesLine, reachOf } from "@light/test/imports.ts";

const reach = reachOf(".");
eq("it reaches " + "@light/highlight, @light/kernel, @light/lib, @light/markdown, @light/ui, @light/workspace, @lightstart/light, @lightstart/markdown, @widecode/agent, @widecode/code, @widecode/conversation, @widecode/screen", packagesLine(reach, "@widecode/chat"), "@light/highlight, @light/kernel, @light/lib, @light/markdown, @light/ui, @light/workspace, @lightstart/light, @lightstart/markdown, @widecode/agent, @widecode/code, @widecode/conversation, @widecode/screen");
ok("and no app", !Array.from(reach.packages).some((p) => !p.startsWith("@")));
done();
