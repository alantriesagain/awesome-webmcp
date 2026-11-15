// The git smart HTTP server over a shared repository, as `git http-backend` would serve it: the
// ref advertisement (`GET /r/<id>/info/refs?service=git-upload-pack`, or `/h/<name>/…` for a hosted
// repository, the service header then
// `git upload-pack --stateless-rpc --advertise-refs`) and the exchange (`POST /r/<id>/git-upload-pack`,
// the body piped into `git upload-pack --stateless-rpc`, its output the answer). A hosted (bare)
// repository serves `git-receive-pack` the same way; a live one refuses it. Protocol v2 rides the
// `Git-Protocol` header into the child's environment; a gzipped body is inflated on the way in.
// Branches outside a repository's filter, remote-tracking refs, stashes and notes stay hidden.
import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createGunzip } from "node:zlib";
import { ProcessRun, SpawnOptions, spawnCapped } from "@light/lib/process.ts";
import { Peer, Registry, SharedRepo } from "./registry.ts";

export const SERVICES = ["git-upload-pack", "git-receive-pack"];
export const ALWAYS_HIDDEN = ["refs/remotes", "refs/stash", "refs/notes"];

/** `s` as a pkt-line: four hex digits of the total length, then the text. */
export const pktLine = (s: string): string => (s.length + 4).toString(16).padStart(4, "0") + s;

/** Whether `address` is on a private network (or the machine itself); IPv4-mapped IPv6 counts as its IPv4. */
export const isPrivateAddress = (address: string): boolean => {
  let a = address;
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (a === "::1" || a === "::") return true;
  if (a.includes(":")) {
    const low = a.toLowerCase();
    return low.startsWith("fe80:") || low.startsWith("fc") || low.startsWith("fd");
  }
  const parts = a.split(".").map((p: string) => Number(p));
  if (parts.length !== 4 || parts.some((n: number) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
};

/** The `-c transfer.hideRefs=…` arguments that keep `repo` to its branches (all of them when it has no filter), its tags, and nothing else. */
export const hideRefsArgs = (repo: SharedRepo): string[] => {
  const out: string[] = [];
  for (const prefix of ALWAYS_HIDDEN) out.push("-c", "transfer.hideRefs=" + prefix);
  if (repo.branches !== null) {
    out.push("-c", "transfer.hideRefs=refs/heads");
    for (const b of repo.branches) out.push("-c", "transfer.hideRefs=!refs/heads/" + b);
  }
  return out;
};

/** The path and the query of a request URL. */
export class RequestUrl {
  readonly path: string;
  readonly query: string;

  constructor(url: string) {
    const at = url.indexOf("?");
    this.path = at < 0 ? url : url.slice(0, at);
    this.query = at < 0 ? "" : url.slice(at + 1);
  }

  param(name: string): string {
    for (const pair of this.query.split("&")) {
      const eq = pair.indexOf("=");
      const key = eq < 0 ? pair : pair.slice(0, eq);
      if (key === name) return decodeURIComponent(eq < 0 ? "" : pair.slice(eq + 1));
    }
    return "";
  }
}

/** A `/r/<id>/<rest>` or `/h/<name>/<rest>` path taken apart: the share's key and what is asked of it. */
export class RepoRoute {
  readonly key: string;
  readonly rest: string;

  constructor(key: string, rest: string) {
    this.key = key;
    this.rest = rest;
  }

  static of(path: string): RepoRoute | null {
    if (!path.startsWith("/r/") && !path.startsWith("/h/")) return null;
    const after = path.slice(3);
    const slash = after.indexOf("/");
    if (slash <= 0) return null;
    return new RepoRoute(path.slice(1, 3) + after.slice(0, slash), after.slice(slash + 1));
  }
}

const headerText = (req: IncomingMessage, name: string): string => {
  const v = req.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0) return v[0];
  return "";
};

export const plain = (res: ServerResponse, status: number, text: string): void => {
  res.writeHead(status, { "content-type": "text/plain", "cache-control": "no-cache" });
  res.end(text + "\n");
};

export const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-cache" });
  res.end(JSON.stringify(value));
};

/** The command line of `service` over `repo`: `env` carries the protocol, then git with its hidden refs. */
export const serviceCommand = (git: string, service: string, repo: SharedRepo, advertise: boolean, protocol: string): string[] => {
  const argv: string[] = [];
  if (protocol.length > 0) argv.push("env", "GIT_PROTOCOL=" + protocol);
  argv.push(git);
  for (const a of hideRefsArgs(repo)) argv.push(a);
  argv.push(service.slice(4), "--stateless-rpc");
  if (advertise) argv.push("--advertise-refs");
  argv.push(repo.path);
  return argv;
};

/** Which service a request may use on `repo`: "" when it may not. */
export const allowedService = (service: string, repo: SharedRepo): string => {
  if (service === "git-upload-pack") return service;
  if (service === "git-receive-pack" && repo.hosted) return service;
  return "";
};

export class GitServer {
  readonly registry: Registry;
  git = "git";
  /** Hears each request served or refused: a line for the log. */
  onLog: ((line: string) => void) | null = null;

  constructor(registry: Registry) {
    this.registry = registry;
  }

  private note(line: string): void {
    const fn = this.onLog;
    if (fn !== null) fn(line);
  }

  /**
   * Serve `req` for `peer` (already authenticated), answering whether the path was one of this
   * server's (`/repos`, `/r/<id>/…`); false leaves it to the caller.
   */
  serve(req: IncomingMessage, res: ServerResponse, peer: Peer): boolean {
    const url = new RequestUrl(req.url ?? "/");
    if (url.path === "/repos") {
      if (req.method !== "GET") plain(res, 405, "only GET");
      else void this.repos(res, peer);
      return true;
    }
    const route = RepoRoute.of(url.path);
    if (route === null) return false;
    const repo = this.registry.repoByKey(route.key);
    if (repo === null || !this.registry.allows(repo, peer)) {
      this.note("404 " + peer.name + " " + url.path);
      plain(res, 404, "no such repository");
      return true;
    }
    const protocol = headerText(req, "git-protocol");
    if (route.rest === "info/refs") {
      if (req.method !== "GET") return plain(res, 405, "only GET"), true;
      const service = allowedService(url.param("service"), repo);
      if (service.length === 0) {
        this.note("403 " + peer.name + " " + repo.name + " " + url.param("service"));
        plain(res, 403, url.param("service") === "git-receive-pack" ? "this repository is served read-only; pushes go to a hosted one" : "the dumb protocol is not served");
        return true;
      }
      this.advertise(res, repo, service, protocol, peer);
      return true;
    }
    const service = allowedService(route.rest, repo);
    if (service.length === 0) {
      plain(res, SERVICES.includes(route.rest) ? 403 : 404, SERVICES.includes(route.rest) ? "this repository is served read-only" : "not found");
      return true;
    }
    if (req.method !== "POST") return plain(res, 405, "only POST"), true;
    this.exchange(req, res, repo, service, protocol, peer);
    return true;
  }

  private advertise(res: ServerResponse, repo: SharedRepo, service: string, protocol: string, peer: Peer): void {
    const argv = serviceCommand(this.git, service, repo, true, protocol);
    const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let headed = false;
    let err = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      if (!headed) {
        headed = true;
        res.writeHead(200, { "content-type": "application/x-" + service + "-advertisement", "cache-control": "no-cache" });
        res.write(pktLine("# service=" + service + "\n") + "0000");
      }
      res.write(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", (e: Error) => {
      this.note("advertise " + repo.name + ": cannot start git: " + e.message);
      if (!headed) plain(res, 500, "cannot start git");
      else res.end();
    });
    child.on("close", (code: number | null) => {
      this.note("refs " + peer.name + " " + repo.name + " " + service + (protocol.length > 0 ? " " + protocol : "") + " -> " + String(code ?? -1) + (err.trim().length > 0 ? " " + err.trim().slice(0, 200) : ""));
      if (!headed) plain(res, 500, "git failed: " + err.trim());
      else res.end();
    });
  }

  private exchange(req: IncomingMessage, res: ServerResponse, repo: SharedRepo, service: string, protocol: string, peer: Peer): void {
    const argv = serviceCommand(this.git, service, repo, false, protocol);
    const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let headed = false;
    let err = "";
    let bytesIn = 0;
    let bytesOut = 0;
    const stdin = child.stdin!;
    stdin.on("error", () => {});
    const gzip = headerText(req, "content-encoding").toLowerCase() === "gzip";
    if (gzip) {
      const inflate = createGunzip();
      inflate.on("data", (chunk: Buffer) => {
        bytesIn += chunk.length;
        stdin.write(chunk);
      });
      inflate.on("end", () => {
        stdin.end();
      });
      inflate.on("error", (e: Error) => {
        this.note("exchange " + repo.name + ": bad gzip body: " + e.message);
        stdin.end();
      });
      req.on("data", (chunk: Buffer) => {
        inflate.write(chunk);
      });
      req.on("end", () => {
        inflate.end();
      });
    } else {
      req.on("data", (chunk: Buffer) => {
        bytesIn += chunk.length;
        stdin.write(chunk);
      });
      req.on("end", () => {
        stdin.end();
      });
    }
    child.stdout!.on("data", (chunk: Buffer) => {
      if (!headed) {
        headed = true;
        res.writeHead(200, { "content-type": "application/x-" + service + "-result", "cache-control": "no-cache" });
      }
      bytesOut += chunk.length;
      res.write(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on("error", (e: Error) => {
      this.note("exchange " + repo.name + ": cannot start git: " + e.message);
      if (!headed) plain(res, 500, "cannot start git");
      else res.end();
    });
    child.on("close", (code: number | null) => {
      this.note(service.slice(4) + " " + peer.name + " " + repo.name + (gzip ? " gzip" : "") + " in " + String(bytesIn) + " out " + String(bytesOut) + " -> " + String(code ?? -1) + (err.trim().length > 0 ? " " + err.trim().slice(0, 200) : ""));
      if (!headed) {
        if (code === 0) {
          res.writeHead(200, { "content-type": "application/x-" + service + "-result", "cache-control": "no-cache" });
          res.end();
        } else plain(res, 500, "git failed: " + err.trim());
      } else res.end();
    });
  }

  /** `GET /repos`: what `peer` may fetch, each with its branches' tips. */
  private async repos(res: ServerResponse, peer: Peer): Promise<void> {
    const out: unknown[] = [];
    for (const repo of this.registry.reposFor(peer)) {
      const o = new SpawnOptions();
      o.timeoutMs = 10000;
      const run: ProcessRun = await spawnCapped(this.git, ["-C", repo.path, "for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"], o);
      const branches: unknown[] = [];
      if (run.ok)
        for (const line of run.text.split("\n")) {
          const tab = line.indexOf("\t");
          if (tab <= 0) continue;
          const name = line.slice(0, tab);
          if (repo.branches !== null && !repo.branches.includes(name)) continue;
          const b: unknown = { name, sha: line.slice(tab + 1) };
          branches.push(b);
        }
      const item: unknown = { key: repo.key, repoId: repo.repoId, name: repo.name, mode: repo.mode, branches };
      out.push(item);
    }
    json(res, 200, { repos: out });
  }
}

/** The bearer token of `req`, "" when it carries none. */
export const bearerOf = (req: IncomingMessage): string => {
  const auth = headerText(req, "authorization");
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
};

/** `address` as a peer is recorded: an IPv4 mapped into IPv6 (`::ffff:1.2.3.4`) as its IPv4. */
export const plainAddress = (address: string): string => (address.startsWith("::ffff:") ? address.slice(7) : address);

/** `address` as a URL names it: an IPv6 address in brackets. */
export const urlHost = (address: string): string => (address.includes(":") ? "[" + address + "]" : address);

/** The address a request came from (an IPv4 mapped into IPv6 as its IPv4), "" when the runtime does not say. */
export const remoteAddressOf = (req: IncomingMessage): string => {
  const a = req.socket.remoteAddress;
  return typeof a === "string" ? plainAddress(a) : "";
};
