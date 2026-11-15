// The folder's session records (the conversation's SessionStore) over the sessions model: one JSONL
// store per folder, opened when a folder opens, the rows followed live, and the synchronous answers
// the conversation and the plugin API take read from them. A save goes through the model in order,
// its record answered from a pending map until the row lands. The records an earlier widecode kept
// as `.widecode/sessions/<id>.json` are imported the first time their folder opens, and left there.
// The account's limits stay the store's (limits.json). The skill runs of the folder's sessions are a
// second model beside them (`.widecode/skills.jsonl`), summed per skill for the Skills tab.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openJsonl } from "@lightstart/light/model/jsonl";
import { LiveRows, modelQuery } from "@lightstart/light/model/binder";
import type { Store as ModelStore } from "@lightstart/light/model/types.ts";
import { effect } from "@lightstart/light/signals";
import { recordOf, text } from "@light/lib/json.ts";
import { Hook } from "@light/lib/hook.ts";
import { Limits, SessionMeta, SessionStore } from "../conversation/session-store.ts";
import { sessions } from "../models/sessions.ts";
import { skills } from "../models/skills.ts";
import { fileIO } from "./file-io.ts";
import { Store } from "./store.ts";

/** A skill run as the folder keeps it. */
export class SkillRunRow {
  id = "";
  session = "";
  agent = "";
  skill = "";
  typed = false;
  state = "";
  startedMs = 0;
  endedMs = 0;
  calls = 0;

  toRow(): Record<string, unknown> {
    return { id: this.id, session: this.session, agent: this.agent, skill: this.skill, typed: this.typed, state: this.state, startedMs: this.startedMs, endedMs: this.endedMs, calls: this.calls };
  }

  static of(r: Record<string, unknown>): SkillRunRow {
    const o = new SkillRunRow();
    o.id = text(r.id, "");
    o.session = text(r.session, "");
    o.agent = text(r.agent, "");
    o.skill = text(r.skill, "");
    o.typed = r.typed === true;
    o.state = text(r.state, "");
    o.startedMs = typeof r.startedMs === "number" ? r.startedMs : 0;
    o.endedMs = typeof r.endedMs === "number" ? r.endedMs : 0;
    o.calls = typeof r.calls === "number" ? r.calls : 0;
    return o;
  }
}

/** A skill's runs across the folder's sessions. */
export class SkillUsage {
  readonly name: string;
  runs = 0;
  typed = 0;
  failed = 0;
  lastMs = 0;

  constructor(name: string) {
    this.name = name;
  }
}

export class SessionRecords extends SessionStore {
  readonly store: Store;
  /** Fires when the folder's records changed (a row landed). */
  readonly changed: Hook;
  /** The folder whose records these are ("" before one opens). */
  folder = "";
  onNote: ((text: string) => void) | null = null;
  private db: ModelStore | null = null;
  private rows: LiveRows<Record<string, unknown>> | null = null;
  private skillRows: LiveRows<Record<string, unknown>> | null = null;
  private readonly skillPending = new Map<string, SkillRunRow>();
  private following: (() => void) | null = null;
  private readonly pending = new Map<string, SessionMeta>();
  private chain: Promise<void> = Promise.resolve();

  constructor(store: Store, changed: Hook) {
    super();
    this.store = store;
    this.changed = changed;
  }

  /** The records of `folder`: its store opened (the one before closed), the old files imported, the rows followed. */
  async open(folder: string): Promise<void> {
    await this.close();
    this.folder = folder;
    const dir = join(folder, ".widecode");
    this.db = await openJsonl({ name: "widecode", dir, io: fileIO(), models: [sessions, skills] });
    await this.importOld(join(dir, "sessions"), folder);
    const rows = new LiveRows<Record<string, unknown>>();
    rows.use(modelQuery<Record<string, unknown>>(sessions, { order: "-updatedMs" }));
    this.rows = rows;
    const run = effect(() => {
      rows.value;
      this.changed.fire();
    });
    const kept = new LiveRows<Record<string, unknown>>();
    kept.use(modelQuery<Record<string, unknown>>(skills, {}));
    this.skillRows = kept;
    const keptRun = effect(() => {
      kept.value;
      this.changed.fire();
    });
    this.following = () => {
      run.dispose();
      keptRun.dispose();
    };
    await rows.loaded();
    await kept.loaded();
  }

  /** Keep run `r` of a skill (written over when its id is kept already). */
  saveSkillRun(r: SkillRunRow): void {
    const row = r.toRow();
    const id = r.id;
    this.skillPending.set(id, r);
    this.chain = this.chain
      .then(async () => {
        if ((await skills.get(id)) === null) await skills.add(row);
        else await skills.edit(id, row);
      })
      .then(
        () => {
          if (this.skillPending.get(id) === r) this.skillPending.delete(id);
        },
        (err: unknown) => {
          if (this.skillPending.get(id) === r) this.skillPending.delete(id);
          const fn = this.onNote;
          if (fn !== null) fn("skill run " + id + ": " + (err instanceof Error ? err.message : String(err)));
        },
      );
  }

  /** Each skill's runs kept in the folder, summed: how many, how many typed and failed, the last. */
  skillUsage(): SkillUsage[] {
    const byId = new Map<string, SkillRunRow>();
    const rows = this.skillRows;
    if (rows !== null) for (const r of rows.peek()) byId.set(text(r.id, ""), SkillRunRow.of(r));
    for (const [id, r] of this.skillPending) byId.set(id, r);
    const out = new Map<string, SkillUsage>();
    for (const r of byId.values()) {
      let u = out.get(r.skill);
      if (u === undefined) {
        u = new SkillUsage(r.skill);
        out.set(r.skill, u);
      }
      u.runs++;
      if (r.typed) u.typed++;
      if (r.state === "failed") u.failed++;
      if (r.startedMs > u.lastMs) u.lastMs = r.startedMs;
    }
    return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The records as a whole, newest first. */
  all(): SessionMeta[] {
    const rows = this.rows;
    const out: SessionMeta[] = [];
    if (rows === null) return out;
    for (const r of rows.peek()) out.push(SessionMeta.of(r, this.folder));
    return out;
  }

  override session(id: string, _folder: string): SessionMeta | null {
    if (id.length === 0) return null;
    const waiting = this.pending.get(id);
    if (waiting !== undefined) return waiting;
    const rows = this.rows;
    if (rows === null) return null;
    for (const r of rows.peek()) if (text(r.id, "") === id) return SessionMeta.of(r, this.folder);
    return null;
  }

  override sessionOrNew(id: string, folder: string): SessionMeta {
    const found = this.session(id, folder);
    if (found !== null) return found;
    const m = new SessionMeta();
    m.id = id;
    m.folder = folder;
    m.createdMs = Date.now();
    this.pending.set(id, m);
    return m;
  }

  override saveSession(m: SessionMeta): void {
    m.updatedMs = Date.now();
    const id = m.id;
    this.pending.set(id, m);
    const row = m.toRow();
    this.chain = this.chain
      .then(async () => {
        if ((await sessions.get(id)) === null) await sessions.add(row);
        else await sessions.edit(id, row);
      })
      .then(
        () => {
          if (this.pending.get(id) === m) this.pending.delete(id);
        },
        (err: unknown) => {
          // The record did not land: stop answering from it, so a save that is retried reads the
          // row (or makes one) rather than a pending value that will never be written.
          if (this.pending.get(id) === m) this.pending.delete(id);
          const fn = this.onNote;
          if (fn !== null) fn("session record " + id + ": " + (err instanceof Error ? err.message : String(err)));
        },
      );
  }

  override limits(agent: string): Limits {
    return this.store.limits(agent);
  }

  /** Every save landed. */
  settled(): Promise<void> {
    return this.chain;
  }

  async close(): Promise<void> {
    await this.chain;
    const following = this.following;
    if (following !== null) following();
    this.following = null;
    const rows = this.rows;
    if (rows !== null) rows.dispose();
    this.rows = null;
    const kept = this.skillRows;
    if (kept !== null) kept.dispose();
    this.skillRows = null;
    this.skillPending.clear();
    const db = this.db;
    this.db = null;
    if (db !== null) await db.close();
    this.pending.clear();
  }

  /** The records an earlier widecode kept as one JSON file per session, into the model once (the files stay). */
  private async importOld(dir: string, folder: string): Promise<void> {
    if (!existsSync(dir)) return;
    const rows: Record<string, unknown>[] = [];
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      let value: unknown = null;
      try {
        value = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        continue;
      }
      const f = recordOf(value);
      if (f === null) continue;
      if ((await sessions.get(id)) !== null) continue;
      const m = SessionMeta.of(f, folder);
      m.id = id;
      rows.push(m.toRow());
    }
    if (rows.length > 0) await sessions.addMany(rows);
  }
}
