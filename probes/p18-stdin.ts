// P18: does raw stdin reach a `data` listener installed the way Terminal.enter() installs it?
import { appendFileSync } from "node:fs";
const log = process.argv[2] ?? "/tmp/p18.log";
const variant = process.argv[3] ?? "A";
appendFileSync(log, "start " + variant + "\n");
if (process.stdin.isTTY === true) process.stdin.setRawMode(true);
const onData = (chunk: Buffer): void => {
  appendFileSync(log, "data " + chunk.toString("hex") + "\n");
  if (chunk.indexOf(0x71) >= 0) process.exit(0);
};
if (variant === "A") {
  // Terminal.enter() order: resume, then listener
  process.stdin.resume();
  process.stdin.on("data", onData);
} else if (variant === "B") {
  // probe tty.ts order: listener only
  process.stdin.on("data", onData);
} else {
  // listener then resume
  process.stdin.on("data", onData);
  process.stdin.resume();
}
process.on("SIGWINCH", () => appendFileSync(log, "winch\n"));
process.on("exit", () => appendFileSync(log, "exit\n"));
setTimeout(() => { appendFileSync(log, "timeout\n"); process.exit(0); }, 4000);
