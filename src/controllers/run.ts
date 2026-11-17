// Which start this is: the run a test set (`next`), or the real app's, its folder from --dir (where
// it was launched by default; not a folder is exit 2). The other controllers import this one, so
// it starts first, and read `current`. `reopen` starts the app again over another folder, with what
// carries over for the next start to take (`takeCarry`).
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Controller } from "@lightstart/light/controller/class.ts";
import app from "../app.ts";
import { Carry, Run } from "../run.ts";

export class RunController extends Controller {
  /** The run the next start takes, set by a test; the real app's when null. */
  next: Run | null = null;
  /** This start's run. */
  current = new Run();
  /** What the next start takes over from this one (an `/open`). */
  private carry: Carry | null = null;

  constructor() {
    super("run");
  }

  override connected(): Promise<void> | null {
    const given = this.next;
    this.next = null;
    this.current = given !== null ? given : this.real();
    return null;
  }

  /** The real app's run: its folder from --dir. */
  private real(): Run {
    const run = new Run();
    run.folder = resolve(app.args.string("dir") ?? process.cwd());
    if (!existsSync(run.folder) || !statSync(run.folder).isDirectory()) {
      console.error("widecode: not a folder: " + run.folder);
      process.exit(2);
    }
    // A development build's built-in plugins, beside it (dist/plugins); an installed binary's are in the plugin folder.
    const beside = join(dirname(process.execPath), "plugins");
    if (existsSync(beside)) run.builtinDir = beside;
    return run;
  }

  /**
   * Start the app again over `folder` (`/open`), `carry` taken by the next start; a test's run
   * carries over too, with the folder read once it starts.
   */
  async reopen(folder: string, carry: Carry): Promise<void> {
    this.carry = carry;
    if (!this.current.real) this.next = this.current.over(folder);
    // The new start resumes nothing, opens no file and starts no selftest: those were the first start's.
    await app.restart({ dir: folder, resume: undefined, open: undefined, selftest: undefined });
  }

  /** What this start takes over from the one before it (null for none); once. */
  takeCarry(): Carry | null {
    const carry = this.carry;
    this.carry = null;
    return carry;
  }
}

export default new RunController();
