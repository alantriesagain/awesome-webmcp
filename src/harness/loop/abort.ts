// A turn's abort: a flag the loop and the clients read, and what to stop at once when it fires
// (a request in flight, a child process, a call waiting on the user), each a `Stopper` holding a
// function, since a Map or Set of functions has no native shape.

export class Stopper {
  stopNow: (() => void) | null = null;
}

export class Abort {
  aborted = false;
  private stoppers: Stopper[] = [];

  /** Stop `s` when the abort fires (at once when it fired already). */
  watch(s: Stopper): void {
    if (this.aborted) {
      const fn = s.stopNow;
      if (fn !== null) fn();
      return;
    }
    this.stoppers.push(s);
  }

  unwatch(s: Stopper): void {
    this.stoppers = this.stoppers.filter((x) => x !== s);
  }

  fire(): void {
    if (this.aborted) return;
    this.aborted = true;
    const all = this.stoppers;
    this.stoppers = [];
    for (const s of all) {
      const fn = s.stopNow;
      if (fn !== null) fn();
    }
  }
}
