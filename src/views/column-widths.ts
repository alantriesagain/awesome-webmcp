// How wide the columns are. A column takes the width its border was dragged to (kept in
// state.json), else the one config.json's "columns" sets (cells, or a percentage of the terminal),
// else the one it asks for; the column that asks for none (the code column) takes the rest. When the
// rest would be under 20 cells the others give way in proportion, none under 12.

/** The fewest cells a column keeps, and the column taking the rest. */
const MIN_CELLS = 12;
const MIN_REST = 20;

/** A width config.json sets: cells, or a share of the terminal (0 for none). */
class Setting {
  readonly cells: number;
  readonly share: number;

  constructor(cells: number, share: number) {
    this.cells = cells;
    this.share = share;
  }
}

/** A setting from config.json: a number of cells, or "40%"; null for anything else. */
export const settingOf = (value: unknown): Setting | null => {
  if (typeof value === "number" && value >= 1) return new Setting(Math.floor(value), 0);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text.endsWith("%")) return null;
  const pct = Number(text.slice(0, text.length - 1));
  return Number.isNaN(pct) || pct <= 0 || pct >= 100 ? null : new Setting(0, pct / 100);
};

/** The id config.json names a column by: the files column is "files" there. */
const idOf = (key: string): string => (key === "files" ? "side" : key);

export class ColumnWidths {
  private readonly set = new Map<string, Setting>();
  private readonly dragged = new Map<string, number>();

  /** config.json's "columns": `{ "chat": "40%", "tools": 40, "files": 30 }`. Answers what it could not use ("" for nothing). */
  configure(value: unknown): string {
    this.set.clear();
    if (value === null || value === undefined) return "";
    if (typeof value !== "object" || Array.isArray(value)) return "columns: not an object";
    const entries = value as Record<string, unknown>;
    const bad: string[] = [];
    for (const key of Object.keys(entries)) {
      const s = settingOf(entries[key]);
      if (s === null || key === "code") bad.push(key);
      else this.set.set(idOf(key), s);
    }
    return bad.length > 0 ? "columns: ignored " + bad.join(", ") + " (a number of cells or a percentage like \"40%\"; the code column takes the rest)" : "";
  }

  /** What a drag left, as state.json keeps it: [id, cells] pairs. */
  kept(): unknown {
    const out: unknown[] = [];
    for (const id of Array.from(this.dragged.keys())) {
      const pair: unknown[] = [id, this.dragged.get(id) ?? 0];
      out.push(pair);
    }
    return out;
  }

  /** Take back what `kept` gave. */
  restore(value: unknown): void {
    this.dragged.clear();
    if (!Array.isArray(value)) return;
    for (const pair of value as unknown[]) {
      if (!Array.isArray(pair)) continue;
      const p = pair as unknown[];
      if (typeof p[0] === "string" && typeof p[1] === "number" && p[1] >= 1) this.dragged.set(p[0], Math.floor(p[1]));
    }
  }

  /** Column `id` dragged to `cells` wide. */
  drag(id: string, cells: number): void {
    this.dragged.set(id, Math.max(MIN_CELLS, Math.floor(cells)));
  }

  /** Forget the dragged widths (config.json's, or the columns' own, again). */
  forget(): void {
    this.dragged.clear();
  }

  /** Whether any column was dragged. */
  any(): boolean {
    return this.dragged.size > 0;
  }

  /** The widths of columns `ids` at `cols` cells, given what each asks for (`own`, 0 for the one taking the rest): 0 stays 0. */
  layout(ids: string[], own: number[], cols: number): number[] {
    const out: number[] = [];
    let fixed = 0;
    let rest = false;
    for (let i = 0; i < ids.length; i++) {
      if (own[i] <= 0) {
        out.push(0);
        rest = true;
        continue;
      }
      const s = this.set.get(ids[i]);
      const d = this.dragged.get(ids[i]);
      let w = own[i];
      if (d !== undefined) w = d;
      else if (s !== undefined) w = s.cells > 0 ? s.cells : Math.floor(cols * s.share);
      w = Math.max(MIN_CELLS, w);
      out.push(w);
      fixed += w;
    }
    // The column taking the rest keeps 20 cells: the others give way in proportion.
    const room = cols - (rest ? MIN_REST : 0);
    if (fixed > room && fixed > 0) {
      const scale = Math.max(0, room) / fixed;
      for (let i = 0; i < out.length; i++) if (out[i] > 0) out[i] = Math.max(MIN_CELLS, Math.floor(out[i] * scale));
    }
    return out;
  }
}
