// The agent's line splitter and launch arguments: a multi-byte character split across chunks, a
// 5 MB line arriving in 5000 chunks (linear time), CRLF endings, the unterminated tail on flush,
// and the `env -u` wrapper with the new flags.
import { AgentOptions, LineSplitter } from "@widecode/agent";
import { budget, done, eq, eqn, ok } from "@light/test/assert.ts";

{
  const s = new LineSplitter();
  const bytes = Buffer.from("héllo\n", "utf8");
  const first = s.push(bytes.subarray(0, 2));
  const second = s.push(bytes.subarray(2));
  eqn("nothing before the newline", first.length, 0);
  eq("multi-byte character joined across chunks", second.join("|"), "héllo");
}

{
  const s = new LineSplitter();
  const piece = "x".repeat(1000);
  const t0 = Date.now();
  let lines: string[] = [];
  for (let i = 0; i < 5000; i++) lines = lines.concat(s.push(Buffer.from(piece, "utf8")));
  lines = lines.concat(s.push(Buffer.from("\nnext\n", "utf8")));
  const ms = Date.now() - t0;
  eqn("a 5 MB line comes out whole", lines.length, 2);
  eqn("its length", lines[0].length, 5000000);
  eq("the line after it", lines[1], "next");
  ok("in linear time (under 2 s)", ms < budget(2000));
}

{
  const s = new LineSplitter();
  const lines = s.push(Buffer.from("a\r\nb\n\nc", "utf8"));
  eq("CRLF endings and empty lines", lines.join("|"), "a|b");
  eq("the unterminated tail on flush", s.flush().join("|"), "c");
  eqn("flush leaves nothing", s.flush().length, 0);
}

{
  const o = new AgentOptions();
  o.executable = "/usr/bin/claude";
  o.cleanEnv = true;
  o.effort = "low";
  o.permissionPromptTool = "stdio";
  o.forwardSubagentText = true;
  o.resume = "abc";
  eq("command", o.command(), "env");
  const args = o.commandArgs();
  eq("env wrapper", args.slice(0, 5).join(" "), "-u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT /usr/bin/claude");
  ok("print mode with stream-json", args.join(" ").includes("-p --input-format stream-json --output-format stream-json"));
  ok("effort", args.join(" ").includes("--effort low"));
  ok("host prompts", args.join(" ").includes("--permission-prompt-tool stdio"));
  ok("subagent text", args.includes("--forward-subagent-text"));
  ok("resume", args.join(" ").includes("--resume abc"));
  const plain = new AgentOptions();
  eq("without cleanEnv the CLI is spawned directly", plain.command(), "claude");
  eq("and its arguments are unchanged", plain.commandArgs().join(" "), plain.args().join(" "));
}

done();
