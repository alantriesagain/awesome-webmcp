// The JS plugins a runtime has: every registration of a context (defs), the ones running in the
// kernel, the folder sources as they were last evaluated, and the generation and instance counters
// a late callback is checked against. One table so a plugin added, replaced or retired is added,
// replaced or retired everywhere.
import type { JsPlugin } from "./runtime.ts";
import { PluginSource } from "@light/plugins/sources.ts";

export class PluginTable {
  private defsList: JsPlugin[] = [];
  private runningList: JsPlugin[] = [];
  /** The folder sources as they were evaluated last. */
  loaded: PluginSource[] = [];
  /** Bumped on each load, so the last load's timers stop. */
  generation = 0;
  /** Bumped as each plugin instance starts (Life). */
  private instances = 0;

  /** Every registration of the context, shadowed ones included. */
  get defs(): JsPlugin[] {
    return this.defsList;
  }

  /** The plugins running in the kernel, in order. */
  get plugins(): JsPlugin[] {
    return this.runningList;
  }

  /** A fresh context: no registrations, no loaded sources, a new generation. */
  reset(): void {
    this.generation++;
    this.defsList = [];
    this.runningList = [];
    this.loaded = [];
  }

  addDef(d: JsPlugin): void {
    this.defsList.push(d);
  }

  removeDef(d: JsPlugin): void {
    this.defsList = this.defsList.filter((x) => x !== d);
  }

  /** The registrations a file made, in order. */
  defsFor(file: string): JsPlugin[] {
    return this.defsList.filter((d) => d.file === file);
  }

  /** The last registration of `id` whose file is still there, or null. */
  lastDef(id: string, there: (file: string) => boolean): JsPlugin | null {
    let found: JsPlugin | null = null;
    for (const d of this.defsList) if (d.id === id && there(d.file)) found = d;
    return found;
  }

  addRunning(p: JsPlugin): void {
    this.runningList.push(p);
  }

  removeRunning(p: JsPlugin): void {
    this.runningList = this.runningList.filter((x) => x !== p);
  }

  /** The running plugin `id`, or null. */
  running(id: string): JsPlugin | null {
    for (const p of this.runningList) if (p.id === id) return p;
    return null;
  }

  /** Plugin `owner`'s instance number, 0 when it does not run. */
  genOf(owner: string): number {
    for (const p of this.runningList) if (p.id === owner) return p.gen;
    return 0;
  }

  /** A new plugin instance's number. */
  nextInstance(): number {
    return ++this.instances;
  }

  addLoaded(source: PluginSource): void {
    this.loaded.push(source);
  }

  removeLoaded(file: string): void {
    this.loaded = this.loaded.filter((s) => s.file !== file);
  }

  /** Forget every loaded source under `dir`. */
  forgetUnder(dir: string): void {
    this.loaded = this.loaded.filter((s) => !s.file.startsWith(dir + "/"));
  }

  /** The loaded sources under `dir`. */
  loadedIn(dir: string): PluginSource[] {
    return this.loaded.filter((s) => s.file.startsWith(dir + "/"));
  }

  /** Replace the loaded sources under `dir` with `sources`. */
  replaceLoaded(dir: string, sources: PluginSource[]): void {
    this.loaded = this.loaded.filter((s) => !s.file.startsWith(dir + "/")).concat(sources);
  }
}
