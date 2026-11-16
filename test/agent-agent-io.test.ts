// The agent's line splitter: a multi-byte character split across chunks, a
// 5 MB line arriving in 5000 chunks (linear time), CRLF endings and the unterminated tail on flush.
import { LineSplitter } from "../src/agent/index.ts";
import { budget, done, eq, eqn, ok } from "@lightstart/test/assert.ts";

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

done();
