// A child process the tools run: its output streamed as it comes, into a cap (the start and the
// end of it, what was between said as omitted) and into a file when one is given, a timeout that
// ends it, a kill handle the abort or BashStop uses (`spawnCapped` of @lightstart/lib gathers to
// the end and has none). A background command is one of these that nobody awaits: it keeps its
// file open and the session hears its end through `BashJobs`.
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** One bash run: `command` in `cwd` (Claude Code's own variables removed), its output as it comes into the cap and the file, killed past `timeoutMs` or on abort (none for a background run). `done` settles at its end; `onFinish` hears it after the file is complete. A detached run is a process group of its own, so `stop` ends what the command started. */
export class BashRun {
  readonly end = new ChildEnd();
  readonly output: CappedText;
  readonly outputPath: string;
  readonly done: Promise<ChildEnd>;
  running = true;
  /** Whether BashStop ended it (a timeout reads as stopped too). */
  stopped = false;
  onFinish: ((end: ChildEnd) => void) | null = null;
  private child: ChildProcess | null = null;
  private resolveDone: ((end: ChildEnd) => void) | null = null;
  private finished = false;
  private readonly detached: boolean;
  private readonly abort: Abort | null;
  private readonly stopper = new Stopper();
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(command: string, cwd: string, timeoutMs: number, output: CappedText, onOutput: ((text: string) => void) | null, abort: Abort | null, outputPath: string, detached = false) {
    this.output = output;
    this.outputPath = outputPath;
    this.detached = detached;
    this.abort = abort;
    if (outputPath.length > 0) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, "");
    }
    this.done = new Promise<ChildEnd>((settle) => {
      this.resolveDone = settle;
    });
    let child: ChildProcess;
    try {
      child = spawn("env", ["-u", "CLAUDECODE", "-u", "CLAUDE_CODE_ENTRYPOINT", "bash", "-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"], detached });
    } catch (e) {
      this.end.error = e instanceof Error ? e.message : "bash could not start";
      this.finish();
      return;
    }
    this.child = child;
    if (abort !== null) {
      this.stopper.stopNow = () => this.kill();
      abort.watch(this.stopper);
    }
    if (timeoutMs > 0) {
      this.timeoutTimer = setTimeout(() => {
        this.end.timedOut = true;
        this.stopped = true;
        this.kill();
      }, timeoutMs);
    }
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const took = (text: string): void => {
      if (text.length === 0) return;
      this.output.push(text);
      if (outputPath.length > 0) {
        try {
          appendFileSync(outputPath, text);
        } catch {
          // The file is a convenience: its loss does not stop the command.
        }
      }
      if (onOutput !== null) onOutput(text);
    };
    child.stdout!.on("data", (c: Buffer) => took(outDecoder.write(c)));
    child.stderr!.on("data", (c: Buffer) => took(errDecoder.write(c)));
    child.on("error", (e: Error) => {
      this.end.error = e.message;
      this.finish();
    });
    child.on("close", (code: number | null) => {
      took(outDecoder.end());
      took(errDecoder.end());
      this.end.code = code === null ? -1 : code;
      this.finish();
    });
  }

  /** End the run now (SIGTERM to its group, SIGKILL after two seconds). */
  stop(): void {
    this.stopped = true;
    this.kill();
  }

  private kill(): void {
    const child = this.child;
    if (child === null || this.finished) return;
    try {
      if (this.detached && child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    if (this.killTimer === null) {
      this.killTimer = setTimeout(() => {
        if (this.finished) return;
        try {
          if (this.detached && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 2000);
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.running = false;
    if (this.timeoutTimer !== null) clearTimeout(this.timeoutTimer);
    if (this.killTimer !== null) clearTimeout(this.killTimer);
    if (this.abort !== null) this.abort.unwatch(this.stopper);
    const resolveDone = this.resolveDone;
    if (resolveDone !== null) resolveDone(this.end);
    const fn = this.onFinish;
    if (fn !== null) fn(this.end);
    this.onFinish = null;
  }
}

/** A background command of a session: its id, what it runs, its output file and the run itself. */
export class BashJob {
  readonly id: string;
  readonly command: string;
  readonly path: string;
  readonly run: BashRun;
  /** Whether its end is sent to the session (false for a session that is going away). */
  notify = true;

  constructor(id: string, command: string, path: string, run: BashRun) {
    this.id = id;
    this.command = command;
    this.path = path;
    this.run = run;
  }

  isRunning(): boolean {
    return this.run.running;
  }

  isStopped(): boolean {
    return this.run.stopped;
  }

  exitCode(): number {
    return this.run.end.code;
  }
}

/** What a session says when one of its background commands ends. */
export const backgroundEndText = (job: BashJob): string => {
  const head = job.isStopped() ? "[background command " + job.id + " was stopped]" : "[background command " + job.id + " exited " + String(job.exitCode()) + "]";
  let tail = job.run.output.text();
  if (tail.endsWith("\n")) tail = tail.slice(0, -1);
  return head + "\nCommand: " + job.command + "\n" + (tail.length > 0 ? tail : "(no output)") + "\nFile: " + job.path;
};

/** The background commands of one session: at most `max` running together, the ended ones kept for BashOutput until the session goes. */
export class BashJobs {
  readonly max = 8;
  /** Hears a command's end, the session's message: null for a subagent, which nothing hears. */
  onEnd: ((job: BashJob) => void) | null = null;
  private jobs: BashJob[] = [];
  private seq = 0;

  runningCount(): number {
    let n = 0;
    for (const job of this.jobs) if (job.isRunning()) n++;
    return n;
  }

  /** Start `command` in the background; its output goes to `<outputDir>/<id>.log` when there is one. */
  start(command: string, cwd: string, timeoutMs: number, outputDir: string): BashJob {
    this.seq++;
    const id = "bash-" + String(this.seq);
    const path = outputDir.length > 0 ? join(outputDir, id + ".log") : "";
    const output = new CappedText(0, 2048);
    const run = new BashRun(command, cwd, timeoutMs, output, null, null, path, true);
    const job = new BashJob(id, command, path, run);
    run.onFinish = () => {
      if (!job.notify) return;
      const fn = this.onEnd;
      if (fn !== null) fn(job);
    };
    this.jobs.push(job);
    return job;
  }

  find(id: string): BashJob | null {
    for (const job of this.jobs) if (job.id === id) return job;
    return null;
  }

  /** Stop `job` now; a command that already ended is left as it is. */
  stop(job: BashJob): void {
    if (!job.isRunning()) return;
    job.run.stop();
  }

  /** Stop every running command without telling the session (it is going away). */
  stopAll(): void {
    for (const job of this.jobs) {
      job.notify = false;
      if (job.isRunning()) job.run.stop();
    }
  }
}
