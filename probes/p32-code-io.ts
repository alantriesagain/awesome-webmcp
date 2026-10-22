// Native capabilities the Claude frontend's backend needs beyond light's probes: positioned
// reads (session file heads and tails), statSync fields, spawn with env and cwd, Buffer.concat
// decoded once (multi-byte text split across chunks), base64 both ways, and fs.watch on a
// single file (.git/index). Prints the same lines under node and natively.
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "p32-"));
const file = join(dir, "big.jsonl");
let text = "";
for (let i = 0; i < 2000; i++) text += JSON.stringify({ type: "line", n: i, note: "héllo ✓" }) + "\n";
writeFileSync(file, text);

const size = statSync(file).size;
console.log("size matches bytes: " + String(size === Buffer.byteLength(text)));
console.log("mtime is a number: " + String(statSync(file).mtimeMs > 0));

const readAt = (path: string, position: number, length: number): string => {
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  closeSync(fd);
  return buf.subarray(0, n).toString("utf8");
};
const head = readAt(file, 0, 200);
console.log("head first line: " + head.slice(0, head.indexOf("\n")));
const tail = readAt(file, size - 300, 300);
const tailLines = tail.split("\n").filter((l) => l.length > 0);
console.log("tail last line: " + tailLines[tailLines.length - 1]);
const cut = tail.indexOf("\n");
console.log("tail starts at a line boundary after the first newline: " + String(tail.slice(cut + 1).startsWith("{")));

const encoded = Buffer.from("héllo ✓ world", "utf8").toString("base64");
console.log("base64: " + encoded);
console.log("decoded: " + Buffer.from(encoded, "base64").toString("utf8"));

const parts = [Buffer.from([0x68, 0xc3]), Buffer.from([0xa9, 0x6c, 0x6c, 0x6f])];
console.log("concat decode: " + Buffer.concat(parts).toString("utf8"));

const env: Record<string, string> = {};
env["PATH"] = process.env["PATH"] ?? "";
env["PROBE_VALUE"] = "from-env";
const child = spawn("sh", ["-c", "printf '%s %s' \"$PROBE_VALUE\" \"$(basename \"$PWD\")\""], { cwd: dir, env: env, stdio: ["ignore", "pipe", "pipe"] });
const chunks: Buffer[] = [];
child.stdout!.on("data", (chunk: Buffer) => {
  chunks.push(chunk);
});
child.on("exit", (code: number | null) => {
  const out = Buffer.concat(chunks).toString("utf8");
  const parts2 = out.split(" ");
  console.log("spawn env: " + parts2[0] + ", cwd is the temp dir: " + String(parts2[1] === dir.split("/").pop()) + ", code " + String(code));
  const watched = join(dir, "index");
  writeFileSync(watched, "a");
  let fired = false;
  const watcher = watch(watched, () => {
    fired = true;
  });
  setTimeout(() => {
    writeFileSync(watched, "b");
    setTimeout(() => {
      watcher.close();
      console.log("single-file watch fired: " + String(fired));
      rmSync(dir, { recursive: true, force: true });
    }, 300);
  }, 100);
});
