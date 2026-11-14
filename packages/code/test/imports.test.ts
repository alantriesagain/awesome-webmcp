// node-only
// What @widecode/code reaches at runtime from its exports: the workspace, the tokenizers, the conversation, the agent's status, ui, light; never the chat.
import { done, eq, ok } from "@light/test/assert.ts";
import { packagesLine, reachOf } from "@light/test/imports.ts";

const reach = reachOf(".");
eq("it reaches " + "@light/lib, @light/markdown, @light/ui, @light/workspace, @lightstart/highlight, @lightstart/light, @lightstart/markdown, @widecode/agent, @widecode/conversation", packagesLine(reach, "@widecode/code"), "@light/lib, @light/markdown, @light/ui, @light/workspace, @lightstart/highlight, @lightstart/light, @lightstart/markdown, @widecode/agent, @widecode/conversation");
ok("and no app", !Array.from(reach.packages).some((p) => !p.startsWith("@")));
ok("and not @widecode/chat", !reach.packages.has("@widecode/chat"));
done();
