// The plugin API's `peers` calls, answered for the runtime (runtime.ts dispatches by namespace):
// the LAN git bridge's daemon reached over its control API (started by the real app when the bridge
// is in use or asked for, and by nothing else), this
// folder's repository shared through it, and a peer's copy set up as a remote of this folder, its
// token written to the local git config (never into a URL, never handed to the plugin).
import { PreludePart } from "@light/plugins/prelude.ts";
import type { JsRuntime } from "../runtime/runtime.ts";
import { HostAnswer } from "@light/plugins/engine.ts";
import { SpawnOptions, spawnCapped } from "@light/lib/process.ts";
import { DaemonClient, Registry, urlHost } from "@widecode/peers";
import { Store } from "../services/store.ts";
import { str, num, json, objectText, listText } from "./values.ts";

const clients = new Map<string, DaemonClient>();

/** The client of this machine's daemon, over the session's store (or the default store without one). */
const clientOf = (rt: JsRuntime): DaemonClient => {
  const store = rt.host.session.store;
  const root = store !== null ? store.root : Store.defaultRoot();
  let c = clients.get(root);
  if (c === undefined) {
    c = new DaemonClient(root);
    clients.set(root, c);
  }
  return c;
};

/** Whether this machine's registry has anything in it: a peer paired or a repository shared. */
const bridgeInUse = (c: DaemonClient): boolean => {
  const r = new Registry(c.paths.registry);
  r.load();
  return r.peers.length + r.repos.length > 0;
};

const gitIn = async (folder: string, args: string[]): Promise<{ code: number; out: string; err: string }> => {
  const o = new SpawnOptions();
  o.timeoutMs = 120000;
  const run = await spawnCapped("env", ["GIT_TERMINAL_PROMPT=0", "git", "-c", "credential.helper=", "-C", folder, ...args], o);
  return { code: run.error.length > 0 ? -1 : run.code, out: run.text, err: run.error.length > 0 ? run.error : run.err };
};

const remoteNameOf = (peerName: string, peerId: string): string => {
  const clean = peerName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return clean.length > 0 ? clean : "peer-" + peerId.slice(0, 8);
};

const requestText = async (rt: JsRuntime, method: string, path: string, body: unknown): Promise<string> => {
  const c = clientOf(rt);
  if (c.state === null) await c.probe();
  const a = await c.request(method, path, body);
  return objectText(["status", "text"], [String(a.status), json(a.text)]);
};

const shareHere = async (rt: JsRuntime): Promise<string> => {
  const c = clientOf(rt);
  if (c.state === null) await c.probe();
  const body: unknown = { path: rt.host.workspace.folder };
  const a = await c.request("POST", "/api/share", body);
  if (!a.ok) return objectText(["key", "error"], [json(""), json(a.status === 0 ? "the peers daemon is not running" : a.text)]);
  let key = "";
  try {
    const v = JSON.parse(a.text) as { repo?: { key?: unknown } };
    key = str(v.repo !== undefined ? v.repo.key : "");
  } catch {
    key = "";
  }
  return objectText(["key", "error"], [json(key), json("")]);
};

/** Peer `peerId`'s copy at `key` as a remote of this folder's repository: the remote's name, "" when the peer is unknown or git refused. */
const setRemote = async (rt: JsRuntime, peerId: string, key: string): Promise<string> => {
  const c = clientOf(rt);
  const registry = new Registry(c.paths.registry);
  registry.load();
  const peer = registry.peerById(peerId);
  if (peer === null || peer.address.length === 0 || peer.port <= 0 || peer.tokenWePresent.length === 0) return json("");
  const base = "http://" + urlHost(peer.address) + ":" + String(peer.port) + "/";
  const name = remoteNameOf(peer.name, peer.id);
  const folder = rt.host.workspace.folder;
  const url = await gitIn(folder, ["config", "--get", "remote." + name + ".url"]);
  if (url.code !== 0) await gitIn(folder, ["remote", "add", name, base + key]);
  else if (url.out.trim() !== base + key) await gitIn(folder, ["remote", "set-url", name, base + key]);
  await gitIn(folder, ["config", "--unset-all", "http." + base + ".extraHeader"]);
  const set = await gitIn(folder, ["config", "--add", "http." + base + ".extraHeader", "Authorization: Bearer " + peer.tokenWePresent]);
  return json(set.code === 0 ? name : "");
};

const ONLINE_MS = 180000;

/** The paired peers that have a remote named after them in this folder's repository: id, name, remote, whether seen lately. */
const peerRemotes = async (rt: JsRuntime): Promise<string> => {
  const c = clientOf(rt);
  const registry = new Registry(c.paths.registry);
  registry.load();
  const names = new Set<string>();
  const listed = await gitIn(rt.host.workspace.folder, ["remote"]);
  for (const line of listed.out.split("\n")) if (line.trim().length > 0) names.add(line.trim());
  const now = Date.now();
  const out: string[] = [];
  for (const p of registry.peers) {
    const remote = remoteNameOf(p.name, p.id);
    if (!names.has(remote)) continue;
    out.push(objectText(["id", "name", "remote", "online", "lastSeenMs"], [json(p.id), json(p.name), json(remote), String(now - p.lastSeenMs < ONLINE_MS), String(p.lastSeenMs)]));
  }
  return listText(out);
};

const fetchRemote = async (rt: JsRuntime, remote: string): Promise<string> => {
  const r = await gitIn(rt.host.workspace.folder, ["fetch", "--prune", remote]);
  return objectText(["code", "out", "err"], [String(r.code), json(r.out), json(r.err)]);
};

/** Plugin call `name` with its arguments `a`, answered; null for a call of another namespace. */
export const answerPeers = (rt: JsRuntime, name: string, a: unknown[]): HostAnswer | null => {
  switch (name) {
    case "peers.ensure": {
      // A daemon is started by the real app alone (the host's launcher), and only when the bridge is
      // asked for (`start`) or already in use here (a peer paired or a repository shared).
      const c = clientOf(rt);
      const launcher = rt.host.peersLauncher;
      const want = launcher.length > 0 && (a[1] === true || bridgeInUse(c));
      return rt.settled(str(a[0]), num(a[2]), c.ensure(want ? launcher : "", []).then((ok: boolean) => json(ok)));
    }
    case "peers.request":
      return rt.settled(str(a[0]), num(a[4]), requestText(rt, str(a[1]), str(a[2]), a[3] === undefined ? null : a[3]));
    case "peers.share":
      return rt.settled(str(a[0]), num(a[1]), shareHere(rt));
    case "peers.remote":
      return rt.settled(str(a[0]), num(a[3]), setRemote(rt, str(a[1]), str(a[2])));
    case "peers.fetch":
      return rt.settled(str(a[0]), num(a[2]), fetchRemote(rt, str(a[1])));
    case "peers.remotes":
      return rt.settled(str(a[0]), num(a[1]), peerRemotes(rt));
  }
  return null;
};

/** The `peers` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_PEERS = new PreludePart("peers", `        ensure: (start) => later("peers.ensure", id, start === true),
        request: (method, path, body) => later("peers.request", id, String(method), String(path), body === undefined ? null : body),
        share: () => later("peers.share", id),
        remote: (peerId, key) => later("peers.remote", id, String(peerId), String(key)),
        fetch: (remote) => later("peers.fetch", id, String(remote)),
        remotes: () => later("peers.remotes", id),
`);
