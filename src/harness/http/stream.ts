// A streaming HTTP request: the body's text reaches `onChunk` as it arrives, the status first,
// and `start` settles when the body ends. Two ways behind one class, chosen by `kind`: `node`
// over node's http and https request with per-chunk data events (the form the native build has
// proven), and `curl` over the curl binary (`-N` unbuffered, `-i` for the status and headers,
// `Expect:` emptied so a large body gets no 100 Continue, the body on stdin, never `-f` so an
// error's body is read). An idle timer ends a stalled stream; `abort` ends it at once. The URL is
// parsed by hand (the native runtime has no URL class the daemon relies on).
import { spawn, type ChildProcess } from "node:child_process";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { objectText } from "@lightstart/lib/json.ts";

export class HttpRequest {
  method = "POST";
  readonly url: string;
  /** Header name and value pairs. */
  headers: string[][] = [];
  body = "";
  /** The stream ends with an error when no byte arrives for this long, and after this long in all. */
  idleMs = 120000;
  totalMs = 1800000;

  constructor(url: string) {
    this.url = url;
  }
}

export class HttpEnd {
  status = 0;
  error = "";
}

/** A URL's parts (`secure`, `host`, `port`, `path`), or null when it is not http(s). */
export class UrlParts {
  secure = false;
  host = "";
  port = 80;
  path = "/";

  static parse(url: string): UrlParts | null {
    const m = /^(https?):\/\/([^/:?#]+)(?::(\d+))?(.*)$/.exec(url);
    if (m === null) return null;
    const u = new UrlParts();
    u.secure = m[1] === "https";
    u.host = m[2];
    u.port = m[3] !== undefined && m[3].length > 0 ? Number(m[3]) : u.secure ? 443 : 80;
    u.path = m[4] !== undefined && m[4].length > 0 ? m[4] : "/";
    return u;
  }
}

export class HttpStream {
  /** "node" or "curl". */
  readonly kind: string;
  onStatus: ((status: number) => void) | null = null;
  onChunk: ((text: string) => void) | null = null;
  private req: ClientRequest | null = null;
  private child: ChildProcess | null = null;
  private aborted = false;

  constructor(kind: string) {
    this.kind = kind;
  }

  start(r: HttpRequest): Promise<HttpEnd> {
    return this.kind === "curl" ? this.startCurl(r) : this.startNode(r);
  }

  abort(): void {
    this.aborted = true;
    const req = this.req;
    if (req !== null) req.destroy(new Error("aborted"));
    const child = this.child;
    if (child !== null) child.kill("SIGKILL");
  }

  private chunk(text: string): void {
    if (text.length === 0) return;
    const fn = this.onChunk;
    if (fn !== null) fn(text);
  }

  private startNode(r: HttpRequest): Promise<HttpEnd> {
    return new Promise<HttpEnd>((settle) => {
      const end = new HttpEnd();
      const u = UrlParts.parse(r.url);
      if (u === null) {
        end.error = "not an http url: " + r.url;
        settle(end);
        return;
      }
      const names: string[] = [];
      const values: string[] = [];
      for (const pair of r.headers) {
        names.push(pair[0]);
        values.push(JSON.stringify(pair[1]));
      }
      names.push("content-length");
      values.push(JSON.stringify(String(Buffer.byteLength(r.body, "utf8"))));
      const headers = JSON.parse(objectText(names, values)) as Record<string, string>;
      let done = false;
      let lastData = Date.now();
      const started = lastData;
      const finish = (error: string): void => {
        if (done) return;
        done = true;
        clearInterval(watch);
        this.req = null;
        if (error.length > 0 && end.error.length === 0) end.error = error;
        settle(end);
      };
      const watch = setInterval(() => {
        if (done) return;
        const now = Date.now();
        if (now - lastData > r.idleMs) {
          end.error = "no data for " + String(Math.round(r.idleMs / 1000)) + " s";
          this.abort();
        } else if (now - started > r.totalMs) {
          end.error = "the request took longer than " + String(Math.round(r.totalMs / 1000)) + " s";
          this.abort();
        }
      }, 1000);
      const decoder = new StringDecoder("utf8");
      const onResponse = (res: IncomingMessage): void => {
        end.status = res.statusCode ?? 0;
        const fn = this.onStatus;
        if (fn !== null) fn(end.status);
        res.on("data", (c: Buffer) => {
          lastData = Date.now();
          this.chunk(decoder.write(c));
        });
        res.on("end", () => {
          this.chunk(decoder.end());
          finish("");
        });
        res.on("error", (e: Error) => finish(e.message));
      };
      const options = { method: r.method, host: u.host, port: u.port, path: u.path, headers };
      let req: ClientRequest;
      try {
        if (u.secure) req = httpsRequest(options, onResponse);
        else req = httpRequest(options, onResponse);
      } catch (e) {
        finish(e instanceof Error ? e.message : "the request could not start");
        return;
      }
      this.req = req;
      req.on("error", (e: Error) => finish(this.aborted ? "aborted" : e.message));
      // A socket error after the request was destroyed (the server ending a held stream) has no
      // listener of its own and would end the process.
      req.on("socket", (socket: Socket) => socket.on("error", () => {}));
      req.write(r.body);
      req.end();
    });
  }

  private startCurl(r: HttpRequest): Promise<HttpEnd> {
    return new Promise<HttpEnd>((settle) => {
      const end = new HttpEnd();
      const args = ["-sS", "-N", "-i", "-X", r.method, "-H", "Expect:", "--max-time", String(Math.ceil(r.totalMs / 1000))];
      for (const pair of r.headers) args.push("-H", pair[0] + ": " + pair[1]);
      if (r.method !== "GET") args.push("--data-binary", "@-");
      args.push(r.url);
      let child: ChildProcess;
      try {
        child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        end.error = e instanceof Error ? e.message : "curl could not start";
        settle(end);
        return;
      }
      this.child = child;
      let done = false;
      let lastData = Date.now();
      let head = "";
      let inHead = true;
      let errText = "";
      const decoder = new StringDecoder("utf8");
      const finish = (error: string): void => {
        if (done) return;
        done = true;
        clearInterval(watch);
        this.child = null;
        if (error.length > 0 && end.error.length === 0) end.error = error;
        settle(end);
      };
      const watch = setInterval(() => {
        if (done) return;
        if (Date.now() - lastData > r.idleMs) {
          end.error = "no data for " + String(Math.round(r.idleMs / 1000)) + " s";
          this.abort();
        }
      }, 1000);
      /** The status line and headers, then the body: a `100 Continue` block is skipped. */
      const took = (text: string): void => {
        if (!inHead) {
          this.chunk(text);
          return;
        }
        head += text;
        for (;;) {
          const at = head.indexOf("\r\n\r\n");
          const atLf = head.indexOf("\n\n");
          const cut = at >= 0 && (atLf < 0 || at < atLf) ? at : atLf;
          const sep = cut === at ? 4 : 2;
          if (cut < 0) return;
          const block = head.slice(0, cut);
          head = head.slice(cut + sep);
          const m = /^HTTP\/[\d.]+ (\d{3})/.exec(block);
          const status = m !== null ? Number(m[1]) : 0;
          if (status === 100) continue;
          end.status = status;
          const fn = this.onStatus;
          if (fn !== null) fn(status);
          inHead = false;
          this.chunk(head);
          head = "";
          return;
        }
      };
      child.stdout!.on("data", (c: Buffer) => {
        lastData = Date.now();
        took(decoder.write(c));
      });
      child.stderr!.on("data", (c: Buffer) => {
        if (errText.length < 4096) errText += c.toString("utf8");
      });
      child.on("error", (e: Error) => finish(e.message));
      child.on("close", (code: number | null) => {
        took(decoder.end());
        const line = errText.split("\n").find((l) => l.trim().length > 0) ?? "";
        if (this.aborted) finish("aborted");
        else if (end.status === 0) finish(line.length > 0 ? line.trim() : "curl exited with code " + String(code ?? -1));
        else finish("");
      });
      child.stdin!.on("error", () => {});
      child.stdin!.write(r.body);
      child.stdin!.end();
    });
  }
}
