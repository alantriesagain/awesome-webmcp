// Finding the other machines on the network: the daemon announces itself as `_widecode._tcp` with its
// id and name in the TXT record, and browses for the others, through the tools each platform has
// (avahi on Linux, dns-sd on macOS); a typed address works without any of this. The parsers are
// pure and tested on recorded output; the processes are kept small and short-lived.
import { spawn, type ChildProcess } from "node:child_process";
import { SpawnOptions, spawnCapped } from "@light/lib/process.ts";
import { isPrivateAddress } from "./git-http.ts";

export const SERVICE_TYPE = "_widecode._tcp";

/** A machine seen announcing itself. */
export class Seen {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly port: number;
  readonly host: string;

  constructor(id: string, name: string, address: string, port: number, host: string) {
    this.id = id;
    this.name = name;
    this.address = address;
    this.port = port;
    this.host = host;
  }

  toJson(): unknown {
    const v: unknown = { id: this.id, name: this.name, address: this.address, port: this.port, host: this.host };
    return v;
  }
}

/** The `key=value` pairs of a TXT record as the tools print them: quoted, space-separated. */
export const parseTxt = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const re = /"([^"]*)"/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const eq = m[1].indexOf("=");
    if (eq > 0) out[m[1].slice(0, eq)] = m[1].slice(eq + 1);
  }
  return out;
};

/** The instance name this machine announces under: unique on the network, the id's first eight hex digits. */
export const instanceName = (id: string): string => "widecode-" + id.slice(0, 8);

/** An interface that is no way to reach another machine: the loopback, a libvirt or docker bridge, a veth or tunnel. */
const virtualInterface = (iface: string): boolean => iface === "lo" || /^(virbr|docker|br-|veth|tun|tap|utun|awdl|llw)/.test(iface);

/** A reachable address scores highest: a private IPv4 on a real interface, then a private IPv4 anywhere, then a private IPv6, then the loopback, then anything. */
const addressScore = (address: string, iface: string): number => {
  if (address.length === 0) return 0;
  if (address === "127.0.0.1" || address === "::1") return 1;
  if (address.includes(":")) return isPrivateAddress(address) ? 2 : 1;
  if (!isPrivateAddress(address)) return 1;
  return virtualInterface(iface) ? 3 : 4;
};

const better = (a: string, b: string): boolean => addressScore(a, "") > addressScore(b, "");

/**
 * `avahi-browse -rptk _widecode._tcp` (Linux): one `=` line per interface and protocol, fields
 * split by `;`: `=;iface;proto;name;type;domain;host;address;port;txt`. One Seen per id, at its
 * best address.
 */
export const parseAvahi = (text: string): Seen[] => {
  const byId = new Map<string, Seen>();
  const scores = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("=;")) continue;
    const f = line.split(";");
    if (f.length < 10) continue;
    const txt = parseTxt(f.slice(9).join(";"));
    const id = txt["id"] ?? "";
    if (id.length === 0) continue;
    const port = Number(f[8]);
    const address = f[7];
    const score = addressScore(address, f[1]);
    const seen = new Seen(id, txt["name"] ?? f[3], address, Number.isInteger(port) ? port : 0, f[6]);
    const had = scores.get(id);
    if (had === undefined || score > had) {
      byId.set(id, seen);
      scores.set(id, score);
    }
  }
  return Array.from(byId.values());
};

/** An instance of the zone listing `dns-sd -Z` prints: its SRV target and port, and its TXT. */
export class ZoneEntry {
  readonly instance: string;
  host = "";
  port = 0;
  txt: Record<string, string> = {};

  constructor(instance: string) {
    this.instance = instance;
  }
}

/**
 * `dns-sd -Z _widecode._tcp .` (macOS), a zone-file listing: `<instance>._widecode._tcp  SRV 0 0
 * <port> <host>.` and `<instance>._widecode._tcp  TXT "k=v" …` lines. The host still needs resolving.
 */
export const parseDnsSdZone = (text: string): ZoneEntry[] => {
  const entries = new Map<string, ZoneEntry>();
  const entryOf = (owner: string): ZoneEntry => {
    const instance = owner.endsWith("." + SERVICE_TYPE) ? owner.slice(0, owner.length - SERVICE_TYPE.length - 1) : owner;
    let e = entries.get(instance);
    if (e === undefined) {
      e = new ZoneEntry(instance);
      entries.set(instance, e);
    }
    return e;
  };
  for (const raw of text.split("\n")) {
    const line = raw.split(";")[0].trim();
    if (line.length === 0 || line.startsWith("_") || line.startsWith("lb.")) continue;
    const srv = /^(\S+)\s+SRV\s+\d+\s+\d+\s+(\d+)\s+(\S+)/.exec(line);
    if (srv !== null) {
      const e = entryOf(srv[1]);
      e.port = Number(srv[2]);
      e.host = srv[3].replace(/\.$/, "");
      continue;
    }
    const txt = /^(\S+)\s+TXT\s+(.*)$/.exec(line);
    if (txt !== null) entryOf(txt[1]).txt = parseTxt(txt[2]);
  }
  return Array.from(entries.values()).filter((e: ZoneEntry) => e.port > 0 && (e.txt["id"] ?? "").length > 0);
};

/** The IPv4 addresses `dscacheutil -q host -a name <host>` lists (`ip_address: …` lines). */
export const parseDscacheutil = (text: string): string[] => {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*ip_address:\s*(\S+)/.exec(line);
    if (m !== null) out.push(m[1]);
  }
  return out;
};

/** This machine announced on the network while it runs: one small process, stopped with the daemon. */
export class Advertiser {
  private child: ChildProcess | null = null;
  /** Hears a line for the log. */
  onLog: ((line: string) => void) | null = null;

  /** The command for `platform` ("darwin", else avahi), or none when the tool is not there. */
  static command(platform: string, id: string, name: string, port: number): string[] {
    const txt = ["id=" + id, "name=" + name];
    if (platform === "darwin") return ["dns-sd", "-R", instanceName(id), SERVICE_TYPE, ".", String(port), ...txt];
    return ["avahi-publish-service", instanceName(id), SERVICE_TYPE, String(port), ...txt];
  }

  start(id: string, name: string, port: number): void {
    this.stop();
    const argv = Advertiser.command(process.platform, id, name, port);
    try {
      const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr!.on("data", (chunk: Buffer) => {
        const fn = this.onLog;
        if (fn !== null) fn("advertise: " + chunk.toString().trim().slice(0, 200));
      });
      child.on("error", (e: Error) => {
        const fn = this.onLog;
        if (fn !== null) fn("advertise: cannot run " + argv[0] + ": " + e.message);
        this.child = null;
      });
      child.on("close", () => {
        this.child = null;
      });
      this.child = child;
    } catch (e) {
      const fn = this.onLog;
      if (fn !== null) fn("advertise: cannot run " + argv[0] + (e instanceof Error ? ": " + e.message : ""));
    }
  }

  get running(): boolean {
    return this.child !== null;
  }

  stop(): void {
    const c = this.child;
    this.child = null;
    if (c !== null) c.kill();
  }
}

/** One look around the network for the others, through the platform's browser. */
export class Browser {
  /** Milliseconds a browse may take (dns-sd keeps listening; it is stopped after this). */
  windowMs = 3000;

  async browse(): Promise<Seen[]> {
    return process.platform === "darwin" ? this.browseDarwin() : this.browseAvahi();
  }

  private async browseAvahi(): Promise<Seen[]> {
    const o = new SpawnOptions();
    o.timeoutMs = this.windowMs + 5000;
    const run = await spawnCapped("avahi-browse", ["-rptk", SERVICE_TYPE], o);
    const none: Seen[] = [];
    return run.error.length > 0 ? none : parseAvahi(run.text);
  }

  private async browseDarwin(): Promise<Seen[]> {
    const o = new SpawnOptions();
    o.timeoutMs = this.windowMs;
    const run = await spawnCapped("dns-sd", ["-Z", SERVICE_TYPE, "."], o);
    const out: Seen[] = [];
    if (run.error.length > 0) return out;
    for (const e of parseDnsSdZone(run.text)) {
      const r = new SpawnOptions();
      r.timeoutMs = 3000;
      const resolved = await spawnCapped("dscacheutil", ["-q", "host", "-a", "name", e.host], r);
      const noAddresses: string[] = [];
      const addresses = resolved.error.length > 0 ? noAddresses : parseDscacheutil(resolved.text);
      let best = "";
      for (const a of addresses) if (better(a, best)) best = a;
      out.push(new Seen(e.txt["id"] ?? "", e.txt["name"] ?? e.instance, best, e.port, e.host));
    }
    return out;
  }
}
