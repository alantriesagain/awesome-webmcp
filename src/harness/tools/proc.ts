// A child process the tools run: its output streamed as it comes and kept within a cap (the
// start and the end of it, what was between said as omitted), a timeout that ends it, a kill
// handle the abort uses (`spawnCapped` of @lightstart/lib gathers to the end and has none).
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

/** What `pi.exec` answers: the two streams, the exit code, whether it was killed, whether either stream was cut. */
export class ExecResult {
  stdout = "";
  stderr = "";
  code = -1;
  killed = false;
  truncated = false;
}

/** One child for `pi.exec`: spawned without a shell, its streams capped as Bash's, a timeout and a kill handle. */
export class ExecProcess {
  readonly result = new ExecResult();
  readonly done: Promise<ExecResult>;
  private child: ChildProcess | null = null;
  private resolveDone: ((r: ExecResult) => void) | null = null;
  private finished = false;
  private readonly out = new CappedText(20000, 10000);
  private readonly err = new CappedText(20000, 10000);
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(command: string, args: string[], cwd: string, timeoutMs: number) {
    this.done = new Promise<ExecResult>((resolve) => {
      this.resolveDone = resolve;
    });
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      this.result.stderr = e instanceof Error ? e.message : "the command could not start";
      this.finish();
      return;
    }
    this.child = child;
    child.stdout!.on("data", (c: Buffer) => this.out.push(outDecoder.write(c)));
    child.stderr!.on("data", (c: Buffer) => this.err.push(errDecoder.write(c)));
    child.on("error", (e: Error) => {
      this.result.stderr = this.result.stderr.length > 0 ? this.result.stderr + "\n" + e.message : e.message;
      this.finish();
    });
    child.on("close", (code: number | null) => {
      this.out.push(outDecoder.end());
      this.err.push(errDecoder.end());
      this.result.code = code === null ? -1 : code;
      this.finish();
    });
    if (timeoutMs > 0) {
      this.timeoutTimer = setTimeout(() => {
        this.result.killed = true;
        this.kill();
      }, timeoutMs);
    }
  }

  /** End the child now (SIGTERM, SIGKILL after two seconds); the result says it was killed. */
  kill(): void {
    const child = this.child;
    if (child === null || this.finished) return;
    this.result.killed = true;
    child.kill("SIGTERM");
    if (this.killTimer === null) {
      this.killTimer = setTimeout(() => {
        if (!this.finished) child.kill("SIGKILL");
      }, 2000);
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.timeoutTimer !== null) clearTimeout(this.timeoutTimer);
    if (this.killTimer !== null) clearTimeout(this.killTimer);
    this.result.stdout = this.out.text();
    this.result.stderr = this.err.text();
    this.result.truncated = this.out.omitted > 0 || this.err.omitted > 0;
    const resolveDone = this.resolveDone;
    if (resolveDone !== null) resolveDone(this.result);
  }
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
