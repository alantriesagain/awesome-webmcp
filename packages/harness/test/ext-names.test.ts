// ffi: @light/plugins/native/ffi.json
// The built-in tools under pi's names and argument names, and a change mapped back: bash keeps its
// command and converts seconds and milliseconds, read and write rename file_path to path, edit
// turns old_string/new_string into one edits[] entry, grep and find rename include and glob, and a
// tool pi lacks keeps its name and input.
import "@light/plugins/engine.ts";
import { fromPiInput, harnessNameOf, piNameOf, toPiInput } from "../ext/names.ts";
import { done, eq } from "@light/test/assert.ts";

eq("the names", ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "LS", "WebFetch", "mcp__x__y"].map(piNameOf).join(","), "bash,read,write,edit,grep,find,ls,WebFetch,mcp__x__y");
eq("the names back", ["bash", "read", "write", "edit", "grep", "find", "ls", "WebFetch"].map(harnessNameOf).join(","), "Bash,Read,Write,Edit,Grep,Glob,LS,WebFetch");

eq("bash: command and the timeout in pi's seconds, description kept under its own name", JSON.stringify(toPiInput("Bash", { command: "ls", timeout: 1500, description: "list" })), '{"command":"ls","timeout":1.5,"description":"list"}');
eq("bash back to milliseconds", JSON.stringify(fromPiInput("Bash", { command: "ls", timeout: 2 })), '{"command":"ls","timeout":2000}');
eq("read renames file_path", JSON.stringify(toPiInput("Read", { file_path: "a.txt", offset: 2, limit: 3 })), '{"offset":2,"limit":3,"path":"a.txt"}');
eq("read back", JSON.stringify(fromPiInput("Read", { path: "a.txt", offset: 2 })), '{"offset":2,"file_path":"a.txt"}');
eq("write renames file_path and keeps content", JSON.stringify(toPiInput("Write", { file_path: "a.txt", content: "x" })), '{"content":"x","path":"a.txt"}');
eq("write back", JSON.stringify(fromPiInput("Write", { path: "a.txt", content: "x" })), '{"content":"x","file_path":"a.txt"}');
eq("edit becomes one edits entry, replace_all still there", JSON.stringify(toPiInput("Edit", { file_path: "a.ts", old_string: "a", new_string: "b", replace_all: true })), '{"replace_all":true,"path":"a.ts","edits":[{"oldText":"a","newText":"b"}]}');
eq("edit back", JSON.stringify(fromPiInput("Edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }], replace_all: true })), '{"replace_all":true,"file_path":"a.ts","old_string":"a","new_string":"b"}');
eq("grep renames include to glob", JSON.stringify(toPiInput("Grep", { pattern: "x", include: "*.ts", ignoreCase: true, context: 2 })), '{"pattern":"x","ignoreCase":true,"context":2,"glob":"*.ts"}');
eq("grep back", JSON.stringify(fromPiInput("Grep", { pattern: "x", glob: "*.ts" })), '{"pattern":"x","include":"*.ts"}');
eq("glob is pi's find", JSON.stringify(toPiInput("Glob", { pattern: "**/*.ts", path: "src" })), '{"pattern":"**/*.ts","path":"src"}');
eq("ls keeps its input", JSON.stringify(toPiInput("LS", { path: "src" })), '{"path":"src"}');
eq("a tool pi lacks keeps its name and input", JSON.stringify(toPiInput("WebFetch", { url: "https://x", prompt: "y" })) + " " + JSON.stringify(fromPiInput("WebFetch", { url: "https://x" })), '{"url":"https://x","prompt":"y"} {"url":"https://x"}');
done();
