// The plugin API's `peers` calls, answered for the runtime (runtime.ts dispatches by namespace):
// the LAN git bridge's daemon reached over its control API (started by the real app when the bridge
// is in use or asked for, and by nothing else), this folder's repository shared through it, a
// peer's offer cloned beside this folder, and the peers whose remote (the daemon's doing, their
// token in the checkout's git config and never in a URL or in the plugin's hands) is in this folder.
import { PreludePart } from "@light/plugins/prelude.ts";
import type { JsRuntime } from "../runtime/runtime.ts";
import { HostAnswer } from "@light/plugins/engine.ts";
import { SpawnOptions, spawnCapped } from "@light/lib/process.ts";
import { dirname, join } from "node:path";
import { DaemonClient, Registry, remoteNameOf } from "@widecode/peers";
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

/** Peer `peerId`'s offer at `key` cloned by the daemon to `path`, beside this folder as `name` when none is given: where, or why not. */
const cloneOffer = async (rt: JsRuntime, peerId: string, key: string, name: string, path: string): Promise<string> => {
  const c = clientOf(rt);
  if (c.state === null) await c.probe();
  const to = path.length > 0 ? (path.startsWith("/") ? path : join(rt.host.workspace.folder, path)) : join(dirname(rt.host.workspace.folder), name);
  const body: unknown = { peerId, key, path: to };
  const a = await c.request("POST", "/api/clone", body);
  if (a.ok) return objectText(["path", "error"], [json(to), json("")]);
  let why = a.status === 0 ? "the peers daemon is not running" : a.text;
  try {
    const v = JSON.parse(a.text) as { error?: unknown };
    if (typeof v.error === "string") why = v.error;
  } catch {
    why = a.status === 0 ? "the peers daemon is not running" : a.text;
  }
  return objectText(["path", "error"], [json(to), json(why)]);
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
    case "peers.clone":
      return rt.settled(str(a[0]), num(a[5]), cloneOffer(rt, str(a[1]), str(a[2]), str(a[3]), str(a[4])));
    case "peers.remotes":
      return rt.settled(str(a[0]), num(a[1]), peerRemotes(rt));
  }
  return null;
};

/** The `peers` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_PEERS = new PreludePart("peers", `        ensure: (start) => later("peers.ensure", id, start === true),
        request: (method, path, body) => later("peers.request", id, String(method), String(path), body === undefined ? null : body),
        share: () => later("peers.share", id),
        clone: (peerId, key, name, path) => later("peers.clone", id, String(peerId), String(key), String(name), path === undefined ? "" : String(path)),
        remotes: () => later("peers.remotes", id),
`);
