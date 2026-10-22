// The views JS plugins draw into the core: side tabs, band strips, and code-column views, each by
// owner so a plugin's reload or retirement takes its own.
import { JsBand, JsPanel, JsRows } from "./views.ts";

export class ViewTable {
  private panelList: JsPanel[] = [];
  private bandList: JsBand[] = [];
  private views = new Map<string, JsRows>();

  get panels(): JsPanel[] {
    return this.panelList;
  }

  get bands(): JsBand[] {
    return this.bandList;
  }

  addPanel(p: JsPanel): void {
    this.panelList.push(p);
  }

  addBand(b: JsBand): void {
    this.bandList.push(b);
  }

  codeView(key: string): JsRows | null {
    return this.views.get(key) ?? null;
  }

  setCodeView(key: string, rows: JsRows): void {
    this.views.set(key, rows);
  }

  /** Drop everything `owner` added. */
  removeOwner(owner: string): void {
    this.panelList = this.panelList.filter((p) => p.owner !== owner);
    this.bandList = this.bandList.filter((b) => b.owner !== owner);
    for (const key of Array.from(this.views.keys())) if (key.startsWith(owner + "\n")) this.views.delete(key);
  }

  /** A new context: nothing drawn. */
  clear(): void {
    this.panelList = [];
    this.bandList = [];
    this.views = new Map<string, JsRows>();
  }
}
