// A child process the tools run: its output streamed as it comes and kept within a cap (the
// start and the end of it, what was between said as omitted), a timeout that ends it, a kill
// handle the abort uses (`spawnCapped` of @light/lib gathers to the end and has none).
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Abort, Stopper } from "../loop/abort.ts";

/** Text kept within a cap: the first `head` bytes and the last `tail`, what fell between counted. */
export class CappedText {
  readonly head: number;
  readonly tail: number;
  private start = "";
  private end = "";
  omitted = 0;

  constructor(head: number, tail: number) {
    this.head = head;
    this.tail = tail;
  }

  push(text: string): void {
    if (this.start.length < this.head) {
      const room = this.head - this.start.length;
      if (text.length <= room) {
        this.start += text;
        return;
      }
      this.start += text.slice(0, room);
      text = text.slice(room);
    }
    this.end += text;
    if (this.end.length > this.tail) {
      this.omitted += this.end.length - this.tail;
      this.end = this.end.slice(this.end.length - this.tail);
    }
  }

  text(): string {
    if (this.omitted === 0) return this.start + this.end;
    return this.start + "\n[… " + String(this.omitted) + " characters omitted …]\n" + this.end;
  }
}

export class ChildEnd {
  code = -1;
  timedOut = false;
  error = "";
}

/** Run `command` with bash in `cwd` (Claude Code's own variables removed), the output to `onOutput` as it comes and into the cap; killed past `timeoutMs` or on abort. */
export const runBash = (command: string, cwd: string, timeoutMs: number, output: CappedText, onOutput: ((text: string) => void) | null, abort: Abort): Promise<ChildEnd> =>
  new Promise<ChildEnd>((settle) => {
    const end = new ChildEnd();
    let child: ChildProcess;
    try {
      child = spawn("env", ["-u", "CLAUDECODE", "-u", "CLAUDE_CODE_ENTRYPOINT", "bash", "-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      end.error = e instanceof Error ? e.message : "bash could not start";
      settle(end);
      return;
    }
    let done = false;
    const stopper = new Stopper();
    const finish = (): void => {
      if (done) return;
      done = true;
      clearInterval(watch);
      abort.unwatch(stopper);
      settle(end);
    };
    const started = Date.now();
    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!done) child.kill("SIGKILL");
      }, 2000);
    };
    stopper.stopNow = () => kill();
    abort.watch(stopper);
    const watch = setInterval(() => {
      if (!done && Date.now() - started > timeoutMs) {
        end.timedOut = true;
        kill();
      }
    }, 250);
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const took = (text: string): void => {
      if (text.length === 0) return;
      output.push(text);
      if (onOutput !== null) onOutput(text);
    };
    child.stdout!.on("data", (c: Buffer) => took(outDecoder.write(c)));
    child.stderr!.on("data", (c: Buffer) => took(errDecoder.write(c)));
    child.on("error", (e: Error) => {
      end.error = e.message;
      finish();
    });
    child.on("close", (code: number | null) => {
      took(outDecoder.end());
      took(errDecoder.end());
      end.code = code === null ? -1 : code;
      finish();
    });
  });
