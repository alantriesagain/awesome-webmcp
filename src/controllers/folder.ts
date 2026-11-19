// This start's folder: its workspace (the repository and the watcher, which gathers changes over the
// run's batch), and the FolderController over it (the files, the git status, the compare base, the
// tree), a new one each start. Disposing closes the watcher.
import { Controller } from "@lightstart/light/controller/class.ts";
import { FolderController } from "@lightstart/workspace/folder.ts";
import { openWorkspace } from "@lightstart/workspace/workspace.ts";
import run from "./run.ts";

export class FolderHolder extends Controller {
  /** This start's; set once the start opened the folder. */
  current!: FolderController;

  constructor() {
    super("folder");
  }

  override connected(): Promise<void> | null {
    return this.open();
  }

  private async open(): Promise<void> {
    const workspace = await openWorkspace(run.current.folder, run.current.batchMs);
    this.current = new FolderController(workspace);
  }

  override disconnected(): Promise<void> | null {
    this.current.workspace.close();
    return null;
  }
}

export default new FolderHolder();
