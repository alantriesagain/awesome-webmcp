// P2: the signals graph shape — abstract Reactive with Set<Reactive>, generic Signal<T> with accessors,
// Computed<T> extends Signal<T> overriding the getter, closures capturing `this` in a generic class.
let current: Reactive | null = null;
let batchDepth = 0;
const pending: Reactive[] = [];

class Dep {
  readonly subs = new Set<Reactive>();
  track(): void {
    if (current === null) return;
    this.subs.add(current);
    current.deps.add(this);
  }
  notify(): void {
    for (const r of Array.from(this.subs)) r.schedule();
  }
}

abstract class Reactive {
  readonly deps = new Set<Dep>();
  disposed = false;
  queued = false;
  abstract run(): void;
  schedule(): void {
    if (this.disposed) return;
    if (batchDepth > 0) {
      if (!this.queued) {
        this.queued = true;
        pending.push(this);
      }
    } else this.execute();
  }
  execute(): void {
    if (this.disposed) return;
    this.cleanup();
    const prev = current;
    current = this;
    try {
      this.run();
    } finally {
      current = prev;
    }
  }
  cleanup(): void {
    for (const d of this.deps) d.subs.delete(this);
    this.deps.clear();
  }
  dispose(): void {
    this.disposed = true;
    this.cleanup();
  }
}

class Effect extends Reactive {
  private readonly fn: () => void;
  constructor(fn: () => void) {
    super();
    this.fn = fn;
    this.execute();
  }
  run(): void {
    this.fn();
  }
}

class Signal<T> {
  protected v: T;
  readonly dep = new Dep();
  constructor(v: T) {
    this.v = v;
  }
  get value(): T {
    this.dep.track();
    return this.v;
  }
  set value(n: T) {
    if (this.v === n) return;
    this.v = n;
    this.dep.notify();
  }
  peek(): T {
    return this.v;
  }
}

class ComputedNode extends Reactive {
  private readonly invalidate: () => void;
  constructor(invalidate: () => void) {
    super();
    this.invalidate = invalidate;
  }
  run(): void {
    this.invalidate();
  }
}

class Computed<T> extends Signal<T> {
  private stale = true;
  private computing = false;
  private readonly fn: () => T;
  private readonly node: ComputedNode;
  constructor(fn: () => T, initial: T) {
    super(initial);
    this.fn = fn;
    this.node = new ComputedNode(() => {
      this.stale = true;
      this.dep.notify();
    });
  }
  override get value(): T {
    if (this.stale && !this.computing) {
      this.computing = true;
      this.node.cleanup();
      const prev = current;
      current = this.node;
      try {
        this.v = this.fn();
      } finally {
        current = prev;
        this.stale = false;
        this.computing = false;
      }
    }
    this.dep.track();
    return this.v;
  }
  override set value(_n: T) {
    throw new Error("computed is read-only");
  }
}

function batch(fn: () => void): void {
  batchDepth++;
  try {
    fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      const effects = pending.splice(0, pending.length);
      for (const e of effects) {
        e.queued = false;
        e.execute();
      }
    }
  }
}

const a = new Signal<number>(1);
const b = new Signal<string>("x");
const sum = new Computed<string>(() => b.value + a.value, "");
const log: string[] = [];
const e = new Effect(() => {
  log.push(sum.value);
});
a.value = 2;
b.value = "y";
batch(() => {
  a.value = 3;
  b.value = "z";
});
e.dispose();
a.value = 4;
console.log(log.join(","), "| peek:", sum.peek(), "| subs after dispose:", sum.dep.subs.size);
