// Server-sent events from a stream's text: an event ends at a blank line and carries its `event:`
// name and its `data:` lines joined with newlines; `id:` lines and `:` comments are skipped. The
// line splitter of @lightstart/lib drops blank lines, which end events here, so this keeps its own.

export class SseEvent {
  readonly event: string;
  readonly data: string;

  constructor(event: string, data: string) {
    this.event = event;
    this.data = data;
  }
}

export class SseSplitter {
  private pending = "";
  private event = "";
  private data: string[] = [];

  /** Text from the stream, in any pieces; the events completed by it. */
  push(text: string): SseEvent[] {
    this.pending += text;
    const out: SseEvent[] = [];
    let at = this.pending.indexOf("\n");
    while (at >= 0) {
      let line = this.pending.slice(0, at);
      this.pending = this.pending.slice(at + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.took(line, out);
      at = this.pending.indexOf("\n");
    }
    return out;
  }

  /** The stream ended: the event left open, if it has data. */
  flush(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.pending.length > 0) {
      this.took(this.pending, out);
      this.pending = "";
    }
    this.took("", out);
    return out;
  }

  private took(line: string, out: SseEvent[]): void {
    if (line.length === 0) {
      if (this.data.length > 0 || this.event.length > 0) out.push(new SseEvent(this.event, this.data.join("\n")));
      this.event = "";
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
  }
}
