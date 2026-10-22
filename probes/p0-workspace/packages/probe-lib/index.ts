export class Greeter {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet(): string {
    return "hello " + this.name;
  }
}

export class Keyed<T> {
  private keys: string[] = [];
  private items: T[] = [];

  put(key: string, item: T): void {
    for (let i = 0; i < this.keys.length; i++)
      if (this.keys[i] === key) {
        this.items[i] = item;
        return;
      }
    this.keys.push(key);
    this.items.push(item);
  }

  get(key: string): T | null {
    for (let i = 0; i < this.keys.length; i++) if (this.keys[i] === key) return this.items[i];
    return null;
  }

  values(): T[] {
    return this.items.slice();
  }
}
