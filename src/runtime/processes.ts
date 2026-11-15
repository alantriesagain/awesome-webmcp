// The long-running processes plugins started: one handle each, by plugin owner, so a plugin's
// reload, its retirement or the app quitting ends exactly its own.
import { PluginProcess } from "@light/plugins/process.ts";

export class ProcessTable {
  private list: PluginProcess[] = [];
  private seq = 0;

  /** A fresh handle for `owner`; the caller sets its callbacks and starts it. */
  create(owner: string): PluginProcess {
    return new PluginProcess(++this.seq, owner);
  }

  add(p: PluginProcess): void {
    this.list.push(p);
  }

  remove(p: PluginProcess): void {
    this.list = this.list.filter((x) => x !== p);
  }

  find(id: number): PluginProcess | null {
    for (const p of this.list) if (p.id === id) return p;
    return null;
  }

  /** End every process `owner` started and forget them. */
  killOwner(owner: string): void {
    for (const p of this.list) if (p.owner === owner) p.kill();
    this.list = this.list.filter((p) => p.owner !== owner);
  }

  /** End every process and forget them. */
  killAll(): void {
    for (const p of this.list) p.kill();
    this.list = [];
  }
}
