// What a conversation keeps about its sessions and reads back: a session's record (its title, the
// model it ran on, its costs, the commit it started on, the file shown in it) and each agent's
// rate limits as it last reported them. The app's store holds them wherever it keeps its data; the
// conversation reads and writes them through this class.

import type { SessionsRow } from "../../.light/models.ts";

export class SessionMeta {
  id = "";
  folder = "";
  title = "";
  /** "claude" or "user". */
  titleBy = "";
  createdMs = 0;
  updatedMs = 0;
  costUsd = 0;
  thinkingTokens = 0;
  /** The model alias the session runs on ("opus[1m]"), resumed with it. */
  model = "";
  effort = "";
  /** The context window the CLI last reported for it (0: not seen). */
  contextWindow = 0;
  /** The commit HEAD was on when the session started ("" before its first turn). */
  baseCommit = "";
  /** The file the code column last showed in it (folder-relative), opened again when it is resumed. */
  file = "";
  /** The agent the session belongs to ("claude", or the id a plugin's agent has), resumed with it; "" in a record from before it was kept. */
  agent = "";

  /** A record from a sessions model row, `folder` its project. */
  static of(row: SessionsRow, folder: string): SessionMeta {
    const m = new SessionMeta();
    m.folder = folder;
    m.id = row.id;
    m.title = row.title;
    m.titleBy = row.titleBy;
    m.createdMs = row.createdMs;
    m.updatedMs = row.updatedMs;
    m.costUsd = row.costUsd;
    m.thinkingTokens = row.thinkingTokens;
    m.model = row.model;
    m.effort = row.effort;
    m.contextWindow = row.contextWindow;
    m.baseCommit = row.baseCommit;
    m.file = row.file;
    m.agent = row.agent;
    return m;
  }

  /** The record as a sessions model row. */
  toRow(): Record<string, unknown> {
    return {
      id: this.id,
      title: this.title,
      titleBy: this.titleBy,
      createdMs: this.createdMs,
      updatedMs: this.updatedMs,
      costUsd: this.costUsd,
      thinkingTokens: this.thinkingTokens,
      model: this.model,
      effort: this.effort,
      contextWindow: this.contextWindow,
      baseCommit: this.baseCommit,
      file: this.file,
      agent: this.agent,
    };
  }
}

export class LimitWindow {
  /** Percent used, -1 when unknown. */
  usedPercent = -1;
  /** Epoch seconds. */
  resetsAt = 0;
}

export class Limits {
  fiveHour = new LimitWindow();
  sevenDay = new LimitWindow();
  updatedMs = 0;
}

/** The records' store, as the conversation uses it. */
export abstract class SessionStore {
  /** Agent `agent`'s rate limits as last reported. */
  abstract limits(agent: string): Limits;
  /** Session `id`'s record in `folder`, or null. */
  abstract session(id: string, folder: string): SessionMeta | null;
  /** Session `id`'s record in `folder`, made when there is none. */
  abstract sessionOrNew(id: string, folder: string): SessionMeta;
  abstract saveSession(m: SessionMeta): void;
}
