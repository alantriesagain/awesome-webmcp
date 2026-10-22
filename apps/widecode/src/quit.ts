// Leaving: the session records are written before the process exits, so the next run sees what
// this one did. No records (--ephemeral) leaves at once.
export class QuitFlusher {
  /** The pending write, or a promise already settled. */
  readonly whenWritten: () => Promise<void>;

  constructor(whenWritten: () => Promise<void>) {
    this.whenWritten = whenWritten;
  }
}

/** Run `then` after the records settle, or at once without records; a failed write still leaves. */
export const flushBeforeExit = (records: QuitFlusher | null, then: () => void): void => {
  if (records !== null) void records.whenWritten().then(then, then);
  else then();
};
