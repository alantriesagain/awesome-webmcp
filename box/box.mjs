#!/usr/bin/env node
/**
 * lightcode's box: a QEMU VM and a lighter bubblewrap jail on the host.
 *
 * Plain QEMU as the user, no root, as bootstrapp's packages/vps/testvm/vm.mjs
 * does: a Debian 13 cloud image as the read-only backing file, a qcow2 overlay
 * per box, a cloud-init seed ISO built with genisoimage, user-mode networking
 * with one hostfwd for SSH, a pid file and a console log.
 *
 * There is one VM. `up` takes every project the box shares, each at its own
 * host path, and keeps the list in the state dir. A second `up` with the same
 * list is a no-op; with a different list it says to restart the box. A lock and
 * the QEMU pid file keep a second VM from starting.
 *
 * Shares use virtiofs when /usr/libexec/virtiofsd exists (one daemon per
 * project, unprivileged, a shared memfd backend for QEMU) and fall back to 9p
 * otherwise. `up` says which it used.
 *
 * `provision` boots once with the network open and builds base.qcow2: the
 * `agent` user (no sudo), git, ripgrep, curl, ca-certificates, the native build
 * toolchain (build-essential, clang), node 24 (the official tarball), pnpm,
 * Claude Code and opencode from their own installers. `up` boots a fresh overlay on base with
 * restrict=on.
 * A per-boot cloud-init seed mounts the shares and bind-mounts .lightcode,
 * .claude and .git read-only, because the project paths change per boot.
 * A host folder, <state>/guest-cache, is shared the same way and mounted over
 * /home/agent/.cache, so the guest's scriptc cache survives down and up.
 *
 * `jail` is the lighter backend: it runs a command under bubblewrap with no
 * network but loopback, no host folders but the project, the tools and a
 * private home, and the proxy over a unix socket. `jail-inner` is the part
 * bwrap runs inside, which carries loopback to that socket.
 *
 * `proxy` is a host-side HTTP(S) proxy on loopback and on <state>/proxy.sock
 * with a domain allow list. `ssh` can forward it (`--forward-proxy`) and other
 * host ports (`--forward`) into the restricted guest, and points the remote
 * command's HTTPS_PROXY at it. Each `ssh` keeps a session file so `down
 * --if-idle` leaves a box several windows share running while one is open.
 *
 * Usage:
 *   node box.mjs provision
 *   node box.mjs up [--memory <MB>] [--cpus <n>] [--port <host>[:<guest>]]... <folder> [<folder>...]
 *   node box.mjs ssh [--forward-proxy <port>] [--forward <remotePort>:<hostPort>]... [--] [cmd...]
 *   node box.mjs proxy [--port N] [--allow domain,...]
 *   node box.mjs jail --proxy-port <port> [--project <dir>]... [--dry-run] -- <cmd...>
 *   node box.mjs creds
 *   node box.mjs down [--if-idle] | status | reset
 */

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE = process.env.LIGHTCODE_BOX_DIR || path.join(os.homedir(), ".cache", "lightcode", "box");
const CACHED_IMAGE = path.join(os.homedir(), ".cache", "bootstrapp", "vps-test", "debian-13-genericcloud-amd64.qcow2");
const IMAGE = "debian-13-genericcloud-amd64.qcow2";
const IMAGE_URL = `https://cloud.debian.org/images/cloud/trixie/latest/${IMAGE}`;

const BASE = path.join(STATE, "base.qcow2");
const BOX = path.join(STATE, "box.qcow2");
const KEY = path.join(STATE, "id_ed25519");
const KNOWN = path.join(STATE, "known_hosts");
const PID = path.join(STATE, "qemu.pid");
const CONSOLE = path.join(STATE, "console.log");
const MONITOR = path.join(STATE, "monitor.sock");
const RECORD = path.join(STATE, "box.json");
const LOCK = path.join(STATE, "box.lock");

/** The paths the box may not write, each read-only over its project: what the host runs without asking. */
const PROTECTED = [".lightcode", ".claude", ".git"];

const PROXY_PID = path.join(STATE, "proxy.pid");
const PROXY_LOG = path.join(STATE, "proxy.log");
const PROXY_SOCK = path.join(STATE, "proxy.sock");
const SESSIONS = path.join(STATE, "sessions");
const JAIL_HOME = path.join(STATE, "jail-home");
const GUEST_CACHE = path.join(STATE, "guest-cache");
const VIRTIOFS = path.join(STATE, "virtiofsd.json");
const VIRTIOFS_DIR = path.join(STATE, "virtiofs");

const SCRIPT = fileURLToPath(import.meta.url);
const HOST_HOME = os.homedir();
const BWRAP = "/usr/bin/bwrap";
const TOOL_NAMES = ["node", "pnpm", "opencode", "claude"];

const ENV_DIR = "/home/agent/.config/lightcode-box";
const ENV_FILE = `${ENV_DIR}/env`;
const OPENCODE_AUTH = "/home/agent/.local/share/opencode/auth.json";
const CREDENTIAL_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "OPENCODE_API_KEY"];

const credentialsPath = () =>
  process.env.LIGHTCODE_BOX_CREDENTIALS || path.join(os.homedir(), ".lightcode", "box", "credentials.env");

const HOST = "127.0.0.1";
const PORT = Number(process.env.LIGHTCODE_BOX_PORT || 2223);
const DEFAULT_MEMORY = Number(process.env.LIGHTCODE_BOX_MEMORY || 4096);
const DEFAULT_CPUS = Number(process.env.LIGHTCODE_BOX_CPUS || 4);
const DISK_SIZE = "40G";
const READY = "/run/lightcode-box-ready";

const DEFAULT_ALLOW = [
  "api.anthropic.com",
  "claude.ai",
  "platform.claude.com",
  "claude.com",
  "statsig.anthropic.com",
  "opencode.ai",
  "*.opencode.ai",
  "registry.npmjs.org",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
];

const QEMU = existsSync("/usr/bin/qemu-system-x86_64") ? "/usr/bin/qemu-system-x86_64" : "qemu-system-x86_64";
const QEMU_IMG = existsSync("/usr/bin/qemu-img") ? "/usr/bin/qemu-img" : "qemu-img";
const VIRTIOFSD = ["/usr/libexec/virtiofsd", "/usr/bin/virtiofsd"].find((file) => existsSync(file)) ?? null;
const VIRTIOFSD_SANDBOX = ["/usr/bin/newuidmap", "/usr/local/bin/newuidmap"].some((file) => existsSync(file))
  ? "namespace"
  : "none";

const say = (/** @type {string} */ msg) => process.stderr.write(`${msg}\n`);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

const forwardSignals = (/** @type {import("node:child_process").ChildProcess} */ child) => {
  const forward = (/** @type {NodeJS.Signals} */ signal) => {
    try { child.kill(signal); } catch {}
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
};

/** @param {string} cmd @param {string[]} args @param {{ quiet?: boolean, timeout?: number, input?: string }} [opts] */
const run = (cmd, args, { quiet = false, timeout = 0, input } = {}) => {
  const stdio = input !== undefined
    ? ["pipe", quiet ? "pipe" : "inherit", quiet ? "pipe" : "inherit"]
    : quiet ? "pipe" : "inherit";
  const result = spawnSync(cmd, args, {
    stdio,
    encoding: "utf8",
    timeout,
    ...(input !== undefined ? { input } : {}),
  });
  if (result.error) throw result.error;
  return result;
};

/** @param {string} cmd @param {string[]} args @param {{ quiet?: boolean, timeout?: number }} [opts] */
const must = (cmd, args, opts) => {
  const result = run(cmd, args, opts);
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${result.status}`);
  return result;
};

const sshOptions = () => [
  "-i", KEY,
  "-p", String(PORT),
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", `UserKnownHostsFile=${KNOWN}`,
  "-o", "LogLevel=ERROR",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=3",
];
const SSH_TARGET = `agent@${HOST}`;

const ssh = (command, opts) => run("ssh", [...sshOptions(), SSH_TARGET, command], opts);

const alive = (/** @type {number} */ value) => {
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
};

const pid = () => {
  if (!existsSync(PID)) return null;
  const value = Number(readFileSync(PID, "utf8").trim());
  return value && alive(value) ? value : null;
};

const proxyPid = () => {
  if (!existsSync(PROXY_PID)) return null;
  const value = Number(readFileSync(PROXY_PID, "utf8").trim());
  return value && alive(value) ? value : null;
};

const reachable = () => ssh("true", { quiet: true, timeout: 10000 }).status === 0;

const liveSessions = () => {
  if (!existsSync(SESSIONS)) return 0;
  let count = 0;
  for (const name of readdirSync(SESSIONS)) {
    const value = Number(name);
    const file = path.join(SESSIONS, name);
    if (!value || !alive(value)) {
      rmSync(file, { force: true });
      continue;
    }
    count += 1;
  }
  return count;
};

const beginSession = () => {
  mkdirSync(SESSIONS, { recursive: true });
  const file = path.join(SESSIONS, String(process.pid));
  writeFileSync(file, "");
  return () => rmSync(file, { force: true });
};

const record = () => {
  if (!existsSync(RECORD)) return {};
  try {
    return JSON.parse(readFileSync(RECORD, "utf8"));
  } catch {
    return {};
  }
};

const saveRecord = (/** @type {Record<string, unknown>} */ value) => {
  writeFileSync(RECORD, `${JSON.stringify(value, null, 2)}\n`);
};

const acquireLock = () => {
  mkdirSync(STATE, { recursive: true });
  try {
    writeFileSync(LOCK, String(process.pid), { flag: "wx" });
    return;
  } catch {
    const owner = Number((existsSync(LOCK) && readFileSync(LOCK, "utf8").trim()) || 0);
    if (owner && owner !== process.pid && alive(owner)) {
      throw new Error(`another box command is running (pid ${owner}); wait for it or run status`);
    }
    rmSync(LOCK, { force: true });
    writeFileSync(LOCK, String(process.pid), { flag: "wx" });
  }
};

const releaseLock = () => {
  try {
    if (readFileSync(LOCK, "utf8").trim() === String(process.pid)) rmSync(LOCK, { force: true });
  } catch {}
};

const ensureKey = () => {
  if (existsSync(KEY)) return;
  say("• generating a keypair for the box only");
  must("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "lightcode-box", "-f", KEY]);
};

const ensureSource = () => {
  if (existsSync(CACHED_IMAGE)) return CACHED_IMAGE;
  const local = path.join(STATE, IMAGE);
  if (existsSync(local)) return local;
  say(`• fetching ${IMAGE} (324 MB, once)`);
  must("curl", ["-fSL", "--progress-bar", "-o", local, IMAGE_URL]);
  return local;
};

const buildSeed = (/** @type {string} */ file, /** @type {string} */ userData) => {
  writeFileSync(path.join(STATE, "user-data"), userData);
  writeFileSync(
    path.join(STATE, "meta-data"),
    `instance-id: ${userData.match(/^instance-id: (.+)$/m)?.[1] ?? "lightcode-box"}\nlocal-hostname: lightcode-box\n`,
  );
  rmSync(file, { force: true });
  must("genisoimage", [
    "-quiet", "-output", file, "-volid", "cidata", "-joliet", "-rock",
    path.join(STATE, "user-data"), path.join(STATE, "meta-data"),
  ]);
};

/**
 * @param {string} disk
 * @param {string} seed
 * @param {{
 *   restrict: boolean,
 *   projects?: string[],
 *   shares?: "virtiofs" | "9p",
 *   sockets?: string[],
 *   memory?: number,
 *   cpus?: number,
 *   ports?: { host: number, guest: number }[],
 * }} opts
 */
const boot = async (
  disk,
  seed,
  { restrict, projects = [], shares = "9p", sockets = [], memory = DEFAULT_MEMORY, cpus = DEFAULT_CPUS, ports = [] },
) => {
  rmSync(CONSOLE, { force: true });
  rmSync(MONITOR, { force: true });
  const forwards = [`hostfwd=tcp:${HOST}:${PORT}-:22`]
    .concat(ports.map((port) => `hostfwd=tcp:${HOST}:${port.host}-:${port.guest}`))
    .join(",");
  const netdev = `user,id=n0${restrict ? ",restrict=on" : ""},${forwards}`;
  const virtiofsd = shares === "virtiofs";
  const qemu = spawn(QEMU, [
    "-enable-kvm",
    "-cpu", "host",
    "-m", String(memory),
    "-smp", String(cpus),
    ...(virtiofsd
      ? [
        "-object", `memory-backend-memfd,id=mem,size=${memory}M,share=on`,
        "-numa", "node,memdev=mem",
      ]
      : []),
    "-drive", `file=${disk},if=virtio,format=qcow2`,
    "-drive", `file=${seed},if=virtio,format=raw,readonly=on`,
    "-netdev", netdev,
    "-device", "virtio-net-pci,netdev=n0",
    ...projects.flatMap((project, index) => virtiofsd
      ? [
        "-chardev", `socket,id=char${index},path=${sockets[index]}`,
        "-device", `vhost-user-fs-pci,chardev=char${index},tag=project${index}`,
      ]
      : [
        "-virtfs", `local,path=${project},mount_tag=project${index},security_model=none`,
      ]),
    "-display", "none",
    "-serial", `file:${CONSOLE}`,
    "-monitor", `unix:${MONITOR},server,nowait`,
    "-daemonize",
    "-pidfile", PID,
  ], { stdio: "inherit" });
  return new Promise((resolve, reject) => {
    qemu.on("exit", (code) => (code === 0 ? resolve(undefined) : reject(new Error(`qemu exited ${code}`))));
    qemu.on("error", reject);
  });
};

const readVirtiofs = () => {
  if (!existsSync(VIRTIOFS)) return [];
  try {
    const value = JSON.parse(readFileSync(VIRTIOFS, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

const startVirtiofs = async (/** @type {string[]} */ projects) => {
  if (!VIRTIOFSD) throw new Error("virtiofsd is missing");
  rmSync(VIRTIOFS_DIR, { recursive: true, force: true });
  mkdirSync(VIRTIOFS_DIR, { recursive: true });
  /** @type {{ pid: number, socket: string, project: string }[]} */
  const entries = [];
  writeFileSync(VIRTIOFS, "[]\n");
  for (const [index, project] of projects.entries()) {
    const socket = path.join(VIRTIOFS_DIR, `project${index}.sock`);
    rmSync(socket, { force: true });
    const child = spawn(
      VIRTIOFSD,
      [
        "--shared-dir", project,
        "--socket-path", socket,
        "--sandbox", VIRTIOFSD_SANDBOX,
        "--seccomp", "kill",
        "--cache", "auto",
        "--xattr",
      ],
      { stdio: "ignore", detached: true },
    );
    child.unref();
    if (!child.pid) throw new Error(`could not start virtiofsd for ${project}`);
    entries.push({ pid: child.pid, socket, project });
    writeFileSync(VIRTIOFS, `${JSON.stringify(entries, null, 2)}\n`);
    const deadline = Date.now() + 15000;
    while (!existsSync(socket)) {
      if (child.exitCode !== null) {
        throw new Error(`virtiofsd exited ${child.exitCode} for ${project}; run virtiofsd by hand to see why`);
      }
      if (Date.now() > deadline) throw new Error(`virtiofsd made no socket for ${project} after 15s`);
      await sleep(100);
    }
    await sleep(200);
    if (child.exitCode !== null) {
      throw new Error(`virtiofsd exited ${child.exitCode} for ${project} right after making its socket`);
    }
  }
  return entries.map((entry) => entry.socket);
};

const stopVirtiofs = async () => {
  const entries = readVirtiofs();
  let stopped = false;
  for (const entry of entries) {
    const value = Number(entry.pid);
    if (!value || !alive(value)) continue;
    stopped = true;
    try { process.kill(value, "SIGTERM"); } catch {}
  }
  if (stopped) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && entries.some((entry) => alive(Number(entry.pid)))) await sleep(100);
    for (const entry of entries) {
      const value = Number(entry.pid);
      if (value && alive(value)) {
        try { process.kill(value, "SIGKILL"); } catch {}
      }
    }
    say("• stopped virtiofsd");
  }
  rmSync(VIRTIOFS, { force: true });
  rmSync(VIRTIOFS_DIR, { recursive: true, force: true });
};

const sendMonitor = (/** @type {string} */ command) => new Promise((resolve, reject) => {
  const socket = net.connect(MONITOR);
  socket.on("error", reject);
  socket.on("connect", () => socket.write(`${command}\n`));
  socket.on("data", () => {
    socket.end();
    resolve(undefined);
  });
  setTimeout(() => {
    socket.destroy();
    resolve(undefined);
  }, 5000);
});

/** @param {number} seconds */
const waitForSsh = async (seconds) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (reachable()) return true;
    if (!pid()) throw new Error(`qemu died; see ${CONSOLE}`);
    await sleep(1000);
  }
  return false;
};

const waitForReady = async (/** @type {number} */ seconds) => {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (ssh(`test -e ${READY}`, { quiet: true, timeout: 10000 }).status === 0) return true;
    await sleep(1000);
  }
  return false;
};

const powerdown = async (/** @type {number} */ timeoutMs = 45000) => {
  const running = pid();
  if (!running) return;
  say(`• asking the guest to power down (pid ${running})`);
  await sendMonitor("system_powerdown").catch(() => undefined);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pid()) {
      rmSync(PID, { force: true });
      say("• stopped");
      return;
    }
    await sleep(500);
  }
  const left = pid();
  if (left) {
    say("• no ACPI shutdown in time, terminating");
    try { process.kill(left, "SIGTERM"); } catch {}
    await sleep(2000);
    if (pid()) {
      try { process.kill(left, "SIGKILL"); } catch {}
      await sleep(500);
    }
  }
  rmSync(PID, { force: true });
};

const stopProxy = async () => {
  const running = proxyPid();
  if (!running) {
    rmSync(PROXY_PID, { force: true });
    return;
  }
  say(`• stopping the proxy (pid ${running})`);
  try { process.kill(running, "SIGTERM"); } catch {}
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && alive(running)) await sleep(100);
  if (alive(running)) {
    try { process.kill(running, "SIGKILL"); } catch {}
  }
  rmSync(PROXY_PID, { force: true });
  rmSync(PROXY_SOCK, { force: true });
};

const yamlBlock = (/** @type {string} */ text) =>
  text.split("\n").map((line) => `      ${line}`).join("\n");

const shq = (/** @type {string} */ value) => `'${value.replace(/'/g, "'\\''")}'`;

const unquote = (/** @type {string} */ value) => {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1);
    }
  }
  return value;
};

/** Refuse a value of the wrong shape, naming the key and what is wrong, never the value. */
const validateCredentials = (/** @type {string} */ file, /** @type {Record<string, string>} */ values) => {
  const claude = values.CLAUDE_CODE_OAUTH_TOKEN || "";
  if (claude.length > 0) {
    if (!claude.startsWith("sk-ant-oat01-")) throw new Error(`${file}: CLAUDE_CODE_OAUTH_TOKEN must start with sk-ant-oat01-`);
    if (!/^[A-Za-z0-9_-]+$/.test(claude)) throw new Error(`${file}: CLAUDE_CODE_OAUTH_TOKEN may contain only letters, digits, "_" and "-"`);
  }
  const opencode = values.OPENCODE_API_KEY || "";
  if (opencode.length > 0) {
    if (/\s/.test(opencode)) throw new Error(`${file}: OPENCODE_API_KEY must contain no whitespace`);
    if (opencode.includes("#")) throw new Error(`${file}: OPENCODE_API_KEY must contain no "#"`);
  }
};

const loadCredentials = () => {
  const file = credentialsPath();
  if (!existsSync(file)) return { file, present: false, values: /** @type {Record<string, string>} */ ({}) };
  const info = lstatSync(file);
  if (!info.isFile()) throw new Error(`${file} is not a regular file`);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  if (info.uid !== uid) throw new Error(`${file} is not owned by you; chown it to your user`);
  const mode = info.mode & 0o777;
  if (mode !== 0o600) throw new Error(`${file} has mode ${mode.toString(8)}; run chmod 600 ${file}`);
  const folder = path.dirname(file);
  const dir = statSync(folder);
  if (dir.uid !== uid) throw new Error(`${folder} is not owned by you; chown it to your user`);
  const dirMode = dir.mode & 0o777;
  if (dirMode !== 0o700) throw new Error(`${folder} has mode ${dirMode.toString(8)}; run chmod 700 ${folder}`);
  const values = /** @type {Record<string, string>} */ ({});
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) throw new Error(`${file} line ${index + 1} is not KEY=value`);
    const key = line.slice(0, eq).trim();
    if (!CREDENTIAL_KEYS.includes(key)) continue;
    values[key] = unquote(line.slice(eq + 1).trim());
  }
  validateCredentials(file, values);
  return { file, present: true, values };
};

const credentialSummary = (/** @type {{ values: Record<string, string> }} */ creds) =>
  `claude ${creds.values.CLAUDE_CODE_OAUTH_TOKEN ? "set" : "empty"}, ` +
  `opencode-go ${creds.values.OPENCODE_API_KEY ? "set" : "empty"}`;

const credentialEnvText = (/** @type {{ values: Record<string, string> }} */ creds) => {
  const claude = creds.values.CLAUDE_CODE_OAUTH_TOKEN || "";
  return claude ? `export CLAUDE_CODE_OAUTH_TOKEN=${shq(claude)}\n` : null;
};

/** @param {string} text @param {string} key */
const mergeOpenCodeAuth = (text, key) => {
  let data = {};
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
    } catch {}
  }
  if (key) data["opencode-go"] = { type: "api", key };
  else delete data["opencode-go"];
  return `${JSON.stringify(data, null, 2)}\n`;
};

/** Write the guest's credential files directly under `root`, for the jail's home. */
const installLocalCredentials = (/** @type {string} */ root, /** @type {{ values: Record<string, string> }} */ creds) => {
  const envDir = path.join(root, ".config", "lightcode-box");
  const envFile = path.join(envDir, "env");
  const env = credentialEnvText(creds);
  if (env) {
    mkdirSync(envDir, { recursive: true, mode: 0o700 });
    chmodSync(envDir, 0o700);
    writeFileSync(envFile, env, { mode: 0o600 });
    chmodSync(envFile, 0o600);
  } else {
    rmSync(envFile, { force: true });
  }
  const authDir = path.join(root, ".local", "share", "opencode");
  const authFile = path.join(authDir, "auth.json");
  const key = creds.values.OPENCODE_API_KEY || "";
  const existing = existsSync(authFile) ? readFileSync(authFile, "utf8") : "";
  if (!key && !existing.trim()) {
    rmSync(authFile, { force: true });
    return;
  }
  mkdirSync(authDir, { recursive: true });
  writeFileSync(authFile, mergeOpenCodeAuth(existing, key), { mode: 0o600 });
  chmodSync(authFile, 0o600);
};

const installCredentials = (/** @type {{ values: Record<string, string> }} */ creds) => {
  const authProbe = ssh(`cat ${OPENCODE_AUTH} 2>/dev/null || true`, { quiet: true, timeout: 30000 });
  const existing = authProbe.status === 0 ? authProbe.stdout || "" : "";
  const env = credentialEnvText(creds);
  const auth = mergeOpenCodeAuth(existing, creds.values.OPENCODE_API_KEY || "");
  const encodedEnv = Buffer.from(env ?? "", "utf8").toString("base64");
  const encodedAuth = Buffer.from(auth, "utf8").toString("base64");
  const script = `#!/bin/bash
set -e
umask 077
mkdir -p ${ENV_DIR}
chmod 700 ${ENV_DIR}
${env
    ? `printf %s ${encodedEnv} | base64 -d > ${ENV_FILE}
chmod 600 ${ENV_FILE}`
    : `rm -f ${ENV_FILE}`}
mkdir -p /home/agent/.local/share/opencode
printf %s ${encodedAuth} | base64 -d > ${OPENCODE_AUTH}
chmod 600 ${OPENCODE_AUTH}
`;
  const result = ssh("bash -s", { quiet: true, input: script, timeout: 30000 });
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim() || `ssh exited ${result.status}`;
    throw new Error(`installing credentials failed: ${detail}`);
  }
};

const provisionUserData = (/** @type {string} */ pub) => `#cloud-config
hostname: lightcode-box
disable_root: true
ssh_pwauth: false
ssh_deletekeys: false

users:
  - name: agent
    shell: /bin/bash
    lock_passwd: true
    ssh_authorized_keys:
      - ${pub}

package_update: true
packages:
  - git
  - ripgrep
  - curl
  - ca-certificates
  - linux-image-amd64
  - build-essential
  - clang
  - xz-utils
  - cloud-guest-utils

write_files:
  - path: /usr/local/bin/lightcode-box-agents
    permissions: '0755'
    content: |
      #!/bin/bash
      set -e
      export DEBIAN_FRONTEND=noninteractive
      CLOUD=$(dpkg -l 'linux-image-*cloud-amd64' | awk '/^ii/ {print $2}')
      if [ -n "$CLOUD" ]; then apt-get purge -y $CLOUD; fi
      update-grub

      # Node 24 from the official tarball; pnpm from npm.
      NODE_BASE=https://nodejs.org/dist/latest-v24.x
      NODE_FILE=$(curl -fsSL "$NODE_BASE/SHASUMS256.txt" | awk '/linux-x64\\.tar\\.xz$/ {print $2; exit}')
      curl -fsSL -o /tmp/node.tar.xz "$NODE_BASE/$NODE_FILE"
      tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
      rm -f /tmp/node.tar.xz
      npm install -g pnpm@10.11.0

      install -d -o agent -g agent /home/agent/.local/bin
      chown -R agent:agent /home/agent/.local

      runuser -l agent -c 'curl -fsSL https://claude.ai/install.sh | bash'
      runuser -l agent -c 'curl -fsSL https://opencode.ai/install | bash'
      echo 'export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH"' > /etc/profile.d/lightcode-box-path.sh

runcmd:
  - [ /usr/local/bin/lightcode-box-agents ]
instance-id: lightcode-box-provision
`;

const upUserData = (/** @type {string[]} */ projects, /** @type {"virtiofs" | "9p"} */ shares) => {
  const mount = shares === "virtiofs"
    ? (/** @type {number} */ index, /** @type {string} */ project) => `mount -t virtiofs project${index} ${shq(project)}`
    : (/** @type {number} */ index, /** @type {string} */ project) =>
      `mount -t 9p -o trans=virtio,version=9p2000.L project${index} ${shq(project)}`;
  const script = `#!/bin/bash
set -e
${projects
  .map(
    (project, index) => `mkdir -p ${shq(project)}
${mount(index, project)}
for rel in ${PROTECTED.join(" ")}; do
  src=${shq(project)}/"$rel"
  if [ -e "$src" ]; then
    mount --bind "$src" "$src"
    mount -o remount,bind,ro "$src"
  fi
done`,
  )
  .join("\n")}
mkdir -p /home/agent/.cache
${mount(projects.length, "/home/agent/.cache")}
chown -R agent:agent /home/agent/.cache
touch ${READY}
`;
  return `#cloud-config
hostname: lightcode-box
disable_root: true
ssh_pwauth: false
ssh_deletekeys: false

write_files:
  - path: /usr/local/bin/lightcode-box-setup
    permissions: '0755'
    content: |
${yamlBlock(script)}
runcmd:
  - [ /usr/local/bin/lightcode-box-setup ]
instance-id: lightcode-box-up-${Date.now()}
`;
};

const agentProbe = [
  'export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH"',
  'for c in claude opencode; do',
  '  p=$(command -v "$c") || { echo "$c: not found"; continue; }',
  '  echo "$c: $p"',
  '  "$c" --version 2>&1 | head -1',
  'done',
  'echo "node: $(node --version)"',
  'echo "pnpm: $(pnpm --version)"',
  'echo "clang: $(clang --version 2>&1 | head -1)"',
].join("\n");

const provision = async () => {
  acquireLock();
  try {
    mkdirSync(STATE, { recursive: true });
    if (pid()) throw new Error(`a box is running (pid ${pid()}); run down first`);
    ensureKey();
    const source = ensureSource();
    const pub = readFileSync(`${KEY}.pub`, "utf8").trim();
    const previous = record();
    const hadProvision = existsSync(BASE) && typeof previous.versions === "string";
    if (hadProvision) {
      say("• base.qcow2 is already provisioned (remove it to rebuild)");
      say(previous.versions);
      return;
    }
    rmSync(KNOWN, { force: true });
    rmSync(BASE, { force: true });
    say(`• creating base.qcow2 on ${source}`);
    must(QEMU_IMG, ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", source, BASE, DISK_SIZE]);
    const seed = path.join(STATE, "seed-provision.iso");
    buildSeed(seed, provisionUserData(pub));
    say(`• provisioning (${DEFAULT_MEMORY}MB, ${DEFAULT_CPUS} vcpu), network open`);
    const started = Date.now();
    await boot(BASE, seed, { restrict: false });
    if (!(await waitForSsh(300))) throw new Error(`no ssh after 300s; see ${CONSOLE}`);
    say(`• ssh answered after ${Math.round((Date.now() - started) / 1000)}s, waiting for cloud-init`);
    const wait = ssh("cloud-init status --wait >/dev/null 2>&1 || true", { quiet: true, timeout: 1800000 });
    if (wait.status !== 0) say("• cloud-init did not confirm success; checking the agents anyway");
    const probe = ssh(agentProbe, { quiet: true, timeout: 120000 });
    const versions = (probe.stdout || "").trim();
    if (probe.status !== 0 || versions.includes("not found")) {
      say(versions || "(no output from the agent probe)");
      throw new Error(`an agent did not install; see ${CONSOLE} and cloud-init-output.log on the guest`);
    }
    say(versions);
    saveRecord({ ...previous, versions, provisionedAt: new Date().toISOString() });
    await powerdown();
    say(`• base.qcow2 provisioned; state in ${STATE}`);
  } finally {
    releaseLock();
  }
};

const sameList = (/** @type {string[]} */ a, /** @type {string[]} */ b) =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

const parsePort = (/** @type {string} */ value) => {
  const [rawHost, rawGuest] = String(value).split(":");
  const host = Number(rawHost);
  const guest = rawGuest === undefined || rawGuest === "" ? host : Number(rawGuest);
  if (!Number.isInteger(host) || host < 1 || host > 65535) throw new Error(`bad --port "${value}"; expected <hostPort>[:<guestPort>]`);
  if (!Number.isInteger(guest) || guest < 1 || guest > 65535) throw new Error(`bad --port "${value}"; expected <hostPort>[:<guestPort>]`);
  return { host, guest };
};

const parseUpArgs = (/** @type {string[]} */ args) => {
  let memory = DEFAULT_MEMORY;
  let cpus = DEFAULT_CPUS;
  /** @type {{ host: number, guest: number }[]} */
  const ports = [];
  /** @type {string[]} */
  const folders = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--memory") {
      memory = Number(args[++index]);
    } else if (arg.startsWith("--memory=")) {
      memory = Number(arg.slice("--memory=".length));
    } else if (arg === "--cpus") {
      cpus = Number(args[++index]);
    } else if (arg.startsWith("--cpus=")) {
      cpus = Number(arg.slice("--cpus=".length));
    } else if (arg === "--port") {
      ports.push(parsePort(String(args[++index])));
    } else if (arg.startsWith("--port=")) {
      ports.push(parsePort(arg.slice("--port=".length)));
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown up option "${arg}"`);
    } else {
      folders.push(arg);
    }
  }
  if (!Number.isInteger(memory) || memory < 512) throw new Error(`bad --memory "${memory}"; expected MB, at least 512`);
  if (!Number.isInteger(cpus) || cpus < 1) throw new Error(`bad --cpus "${cpus}"; expected a count of 1 or more`);
  return { folders, memory, cpus, ports };
};

const up = async (/** @type {string[]} */ args) => {
  const { folders, memory, cpus, ports } = parseUpArgs(args);
  if (!folders.length) throw new Error("up needs at least one project folder");
  if (!existsSync(BASE)) throw new Error("no base.qcow2; run provision first");
  const projects = folders.map((folder) => path.resolve(folder));
  for (const project of projects) {
    if (!existsSync(project)) throw new Error(`no such folder: ${project}`);
  }
  if (new Set(projects).size !== projects.length) throw new Error("a folder is listed twice");
  const creds = loadCredentials();
  const forcedShares = process.env.LIGHTCODE_BOX_SHARES === "9p" ? "9p" : process.env.LIGHTCODE_BOX_SHARES === "virtiofs" ? "virtiofs" : null;
  if (forcedShares === "virtiofs" && !VIRTIOFSD) throw new Error("LIGHTCODE_BOX_SHARES=virtiofs but virtiofsd is missing");
  const shares = forcedShares ?? (VIRTIOFSD ? "virtiofs" : "9p");
  acquireLock();
  try {
    const running = pid();
    const saved = record();
    const previous = Array.isArray(saved.projects)
      ? saved.projects
      : typeof saved.project === "string"
        ? [saved.project]
        : [];
    if (running) {
      if (sameList(previous, projects)) {
        say(`• the box already runs with these projects (pid ${running}); nothing to do`);
        return;
      }
      throw new Error(
        `the box is running with ${previous.length ? previous.join(", ") : "no projects"}; ` +
          "the project list changed, so run down, then up again (one VM for every project)",
      );
    }
    mkdirSync(STATE, { recursive: true });
    rmSync(BOX, { force: true });
    say("• creating box.qcow2 on base.qcow2");
    must(QEMU_IMG, ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", BASE, BOX, DISK_SIZE]);
    mkdirSync(GUEST_CACHE, { recursive: true, mode: 0o700 });
    chmodSync(GUEST_CACHE, 0o700);
    const shared = [...projects, GUEST_CACHE];
    const seed = path.join(STATE, "seed-up.iso");
    buildSeed(seed, upUserData(projects, shares));
    say(
      `• booting restricted, ${projects.length} project(s) on ${shares}, ` +
        `${memory}MB, ${cpus} vcpu, ssh on ${HOST}:${PORT}`,
    );
    for (const [index, project] of projects.entries()) say(`• project${index}: ${project}`);
    say(`• guest cache: ${GUEST_CACHE}`);
    for (const port of ports) say(`• port: ${HOST}:${port.host} -> guest ${port.guest}`);
    if (shares === "virtiofs") say(`• virtiofsd: ${VIRTIOFSD} (unprivileged, sandbox ${VIRTIOFSD_SANDBOX})`);
    else if (forcedShares === "9p") say("• 9p forced by LIGHTCODE_BOX_SHARES=9p");
    else say("• virtiofsd not found; using 9p (slower)");
    const started = Date.now();
    let sockets = [];
    try {
      if (shares === "virtiofs") sockets = await startVirtiofs(shared);
      await boot(BOX, seed, { restrict: true, projects: shared, shares, sockets, memory, cpus, ports });
      if (!(await waitForSsh(180))) throw new Error(`no ssh after 180s; see ${CONSOLE}`);
      const sshSeconds = Math.round((Date.now() - started) / 1000);
      say(`• ssh answered after ${sshSeconds}s, waiting for the shares`);
      if (!(await waitForReady(120))) throw new Error(`the share did not mount; see ${CONSOLE} and cloud-init-output.log`);
      if (creds.present) {
        installCredentials(creds);
        say(`• credentials installed: ${credentialSummary(creds)}`);
      } else {
        say(`• no credentials file at ${creds.file}; the agents start without credentials`);
      }
      const next = {
        ...record(), projects, shares, memory, cpus, ports,
        upAt: new Date().toISOString(), sshSeconds,
      };
      delete next.project;
      saveRecord(next);
      say(`• up; ssh -i ${KEY} -p ${PORT} ${SSH_TARGET}`);
    } catch (error) {
      await stopVirtiofs();
      if (pid()) await powerdown();
      throw error;
    }
  } finally {
    releaseLock();
  }
};

const down = async (/** @type {string[]} */ args = []) => {
  acquireLock();
  try {
    if (args.includes("--if-idle")) {
      const sessions = liveSessions();
      if (sessions > 0) {
        say(`• the box is in use by ${sessions} session(s)`);
        return;
      }
    }
    await stopProxy();
    const running = pid();
    if (!running) say("• the VM is not running");
    else await powerdown();
    await stopVirtiofs();
  } finally {
    releaseLock();
  }
};

const reset = async () => {
  acquireLock();
  try {
    await stopProxy();
    if (pid()) await powerdown();
    await stopVirtiofs();
    rmSync(BOX, { force: true });
    rmSync(PID, { force: true });
    const next = { ...record() };
    delete next.projects;
    delete next.project;
    delete next.upAt;
    delete next.sshSeconds;
    saveRecord(next);
    say("• box.qcow2 dropped; base.qcow2 kept");
  } finally {
    releaseLock();
  }
};

const status = (/** @type {string[]} */ args) => {
  const running = pid();
  const saved = record();
  const projects = Array.isArray(saved.projects)
    ? saved.projects
    : typeof saved.project === "string"
      ? [saved.project]
      : [];
  const proxy = proxyPid();
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify({ running: running !== null, projects, proxy: proxy !== null }) + "\n");
    return;
  }
  say(`pid:       ${running ?? "not running"}`);
  say(`ssh:       ${running && reachable() ? `${HOST}:${PORT}` : "unreachable"}`);
  say(`proxy:     ${proxy ? `running (pid ${proxy}, log ${PROXY_LOG})` : "not running"}`);
  say(`projects:  ${running && projects.length ? projects.join(", ") : projects.length ? `${projects.join(", ")} (last)` : "none"}`);
  if (typeof saved.shares === "string") say(`shares:    ${saved.shares}`);
  if (typeof saved.memory === "number") say(`memory:    ${saved.memory} MB, ${saved.cpus} vcpu`);
  if (Array.isArray(saved.ports) && saved.ports.length) {
    say(`ports:     ${saved.ports.map((port) => `${port.host}->${port.guest}`).join(", ")}`);
  }
  if (readVirtiofs().length && readVirtiofs().every((entry) => alive(Number(entry.pid)))) say("virtiofsd: running");
  say(`base:      ${existsSync(BASE) ? BASE : "missing (run provision)"}`);
  say(`overlay:   ${existsSync(BOX) ? BOX : "missing (run up)"}`);
  say(`key:       ${KEY}`);
  say(`state:     ${STATE}`);
  say(`console:   ${CONSOLE}`);
  if (typeof saved.versions === "string") say(`agents:    ${saved.versions.replace(/\n/g, ", ")}`);
};

const credsCommand = () => {
  const creds = loadCredentials();
  say(`file:       ${creds.file}${creds.present ? "" : " (missing)"}`);
  for (const key of CREDENTIAL_KEYS) say(`  ${key}: ${creds.values[key] ? "set" : "empty"}`);
  const running = pid();
  if (!running) {
    say("box:        not running");
    return;
  }
  const claudeProbe = ssh(
    `if [ -f ${ENV_FILE} ]; then . ${ENV_FILE}; fi; ` +
      'if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo set; else echo empty; fi',
    { quiet: true, timeout: 10000 },
  );
  const claude = (claudeProbe.stdout || "").trim() === "set" ? "set" : "empty";
  const authProbe = `python3 - <<'PY'
import json
try:
    with open(${JSON.stringify(OPENCODE_AUTH)}) as handle:
        data = json.load(handle)
except (FileNotFoundError, ValueError):
    data = {}
entry = data.get("opencode-go")
print("present" if isinstance(entry, dict) and entry.get("key") else "absent")
PY
`;
  const authResult = ssh("bash -s", { quiet: true, timeout: 10000, input: authProbe });
  const opencode = (authResult.stdout || "").trim() === "present" ? "present" : "absent";
  say(`box:        claude ${claude}, opencode-go ${opencode}`);
};

const hostAllowed = (/** @type {string} */ host, /** @type {string[]} */ allow) => {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith("*.")) return name.endsWith(`.${pattern.slice(2)}`);
    return name === pattern;
  });
};

const logProxy = (/** @type {string} */ line) => {
  mkdirSync(STATE, { recursive: true });
  appendFileSync(PROXY_LOG, `${new Date().toISOString()} ${line}\n`);
};

const proxy = async (/** @type {string[]} */ args) => {
  let port = Number(process.env.LIGHTCODE_BOX_PROXY_PORT || 8888);
  let allow = DEFAULT_ALLOW;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      port = Number(args[++index]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--allow") {
      allow = String(args[++index] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    } else if (arg.startsWith("--allow=")) {
      allow = arg.slice("--allow=".length).split(",").map((value) => value.trim()).filter(Boolean);
    } else {
      throw new Error(`unknown proxy option "${arg}"`);
    }
  }
  if (!port || port < 1 || port > 65535) throw new Error(`bad proxy port "${port}"`);
  if (!allow.length) throw new Error("the allow list is empty");
  if (proxyPid()) throw new Error(`a proxy is already running (pid ${proxyPid()}); stop it first`);

  const handleRequest = (req, res) => {
    let target;
    try {
      target = new URL(String(req.url));
    } catch {
      logProxy(`refused ${req.method} ${req.url} (not an absolute URL)`);
      res.writeHead(400).end("bad request\n");
      return;
    }
    if (!hostAllowed(target.hostname, allow)) {
      logProxy(`refused ${req.method} ${target.href}`);
      res.writeHead(403).end("forbidden\n");
      return;
    }
    logProxy(`allowed ${req.method} ${target.href}`);
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: req.headers,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      try { res.writeHead(502); } catch {}
      res.end("upstream error\n");
    });
    req.pipe(upstream);
  };

  const handleConnect = (req, clientSocket, head) => {
    const [rawHost, rawPort] = String(req.url).split(":");
    const host = rawHost ?? "";
    const targetPort = Number(rawPort || 443);
    clientSocket.on("error", () => undefined);
    if (!hostAllowed(host, allow)) {
      logProxy(`refused CONNECT ${host}:${targetPort}`);
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    logProxy(`allowed CONNECT ${host}:${targetPort}`);
    const upstream = net.connect(targetPort, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    });
    clientSocket.on("close", () => upstream.destroy());
  };

  const server = http.createServer(handleRequest);
  server.on("connect", handleConnect);
  const socketServer = http.createServer(handleRequest);
  socketServer.on("connect", handleConnect);

  rmSync(PROXY_SOCK, { force: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve(undefined));
  });
  await new Promise((resolve, reject) => {
    socketServer.once("error", reject);
    socketServer.listen(PROXY_SOCK, () => resolve(undefined));
  });
  chmodSync(PROXY_SOCK, 0o600);
  writeFileSync(PROXY_PID, String(process.pid));
  logProxy(`started on ${HOST}:${port} and ${PROXY_SOCK}, allow ${allow.join(",")}`);
  say(`• proxy listening on http://${HOST}:${port} and ${PROXY_SOCK}`);
  say(`• allow: ${allow.join(", ")}`);
  say(`• log: ${PROXY_LOG}`);
  const stop = () => {
    try { server.close(); } catch {}
    try { socketServer.close(); } catch {}
    rmSync(PROXY_SOCK, { force: true });
    if (existsSync(PROXY_PID) && readFileSync(PROXY_PID, "utf8").trim() === String(process.pid)) {
      rmSync(PROXY_PID, { force: true });
    }
    logProxy("stopped");
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await new Promise(() => undefined);
};

const inside = (/** @type {string} */ child, /** @type {string} */ parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const findExecutable = (/** @type {string} */ name) => {
  const search = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  for (const dir of search.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      const info = statSync(candidate);
      if (!info.isFile() || (info.mode & 0o111) === 0) continue;
      return realpathSync(candidate);
    } catch {}
  }
  return null;
};

const coveredBySystem = (/** @type {string} */ value) =>
  value === "/usr" || value.startsWith("/usr/") || value === "/etc" || value.startsWith("/etc/");

const toolMounts = () => {
  /** @type {string[]} */
  const mounts = [];
  /** @type {string[]} */
  const dirs = [];
  const addMount = (/** @type {string} */ value) => {
    if (!mounts.includes(value)) mounts.push(value);
  };
  const addDir = (/** @type {string} */ value) => {
    if (!dirs.includes(value)) dirs.push(value);
  };
  for (const name of TOOL_NAMES) {
    const resolved = findExecutable(name);
    if (!resolved) continue;
    if (name === "opencode") {
      const bin = path.join(HOST_HOME, ".opencode", "bin");
      const folder = existsSync(bin) ? realpathSync(bin) : path.dirname(resolved);
      addMount(folder);
      addDir(path.dirname(resolved));
      continue;
    }
    if (name === "node") {
      const match = /^(.*[/\\]\.nvm[/\\]versions[/\\]node[/\\][^/\\]+)/.exec(resolved);
      addMount(match ? match[1] : path.dirname(resolved));
      addDir(path.dirname(resolved));
      continue;
    }
    addMount(path.dirname(resolved));
    addDir(path.dirname(resolved));
  }
  return { mounts: mounts.filter((value) => !coveredBySystem(value)), dirs };
};

/**
 * The bwrap mounts that keep `project`'s protected paths from the jail. `.git` is read-only whole:
 * its config, a `commondir` file and its hooks all decide what the host's git runs. A protected
 * path is a mount point, so it cannot be renamed away and replaced; a task's worktree under
 * `.worktrees/` is a folder with a `.git` file naming its git dir, so `.worktrees` and each
 * worktree are bound onto themselves first, which keeps them from being renamed the same way.
 */
const protectedMounts = (/** @type {string} */ project) => {
  /** @type {string[]} */
  const args = [];
  const roots = [project];
  const worktrees = path.join(project, ".worktrees");
  if (existsSync(worktrees) && lstatSync(worktrees).isDirectory()) {
    args.push("--bind", worktrees, worktrees);
    for (const name of readdirSync(worktrees)) {
      const tree = path.join(worktrees, name);
      if (!lstatSync(tree).isDirectory() || !existsSync(path.join(tree, ".git"))) continue;
      args.push("--bind", tree, tree);
      roots.push(tree);
    }
  }
  for (const root of roots)
    for (const rel of PROTECTED) {
      const protectedPath = path.join(root, rel);
      if (existsSync(protectedPath)) args.push("--ro-bind", protectedPath, protectedPath);
    }
  return args;
};

const jailArgv = (
  /** @type {number} */ port,
  /** @type {string[]} */ projects,
  /** @type {string} */ cwd,
  /** @type {string[]} */ command,
) => {
  const args = [
    BWRAP,
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
  ];
  args.push("--ro-bind", "/usr", "/usr");
  args.push("--ro-bind", "/etc", "/etc");
  for (const name of ["bin", "lib", "lib64", "sbin"]) {
    const host = `/${name}`;
    let info;
    try {
      info = lstatSync(host);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) args.push("--symlink", readlinkSync(host), host);
    else args.push("--ro-bind", host, host);
  }
  args.push("--bind", JAIL_HOME, HOST_HOME);
  for (const project of projects) {
    args.push("--bind", project, project);
    args.push(...protectedMounts(project));
  }
  const tools = toolMounts();
  for (const mount of tools.mounts) args.push("--ro-bind", mount, mount);
  args.push("--ro-bind", SCRIPT, SCRIPT);
  args.push("--bind", PROXY_SOCK, PROXY_SOCK);
  args.push("--chdir", cwd);
  args.push("--clearenv");
  const pathValue = [...tools.dirs, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const proxy = `http://127.0.0.1:${port}`;
  args.push("--setenv", "HOME", HOST_HOME);
  args.push("--setenv", "USER", process.env.USER || os.userInfo().username);
  args.push("--setenv", "PATH", pathValue);
  args.push("--setenv", "LANG", process.env.LANG || "C.UTF-8");
  args.push("--setenv", "TERM", process.env.TERM || "xterm-256color");
  args.push("--setenv", "HTTPS_PROXY", proxy);
  args.push("--setenv", "HTTP_PROXY", proxy);
  args.push("--setenv", "https_proxy", proxy);
  args.push("--setenv", "http_proxy", proxy);
  args.push("--setenv", "NO_PROXY", "localhost,127.0.0.1");
  args.push(
    "node", SCRIPT, "jail-inner",
    "--proxy-port", String(port),
    "--socket", PROXY_SOCK,
    "--", ...command,
  );
  return args;
};

const parseJailArgs = (/** @type {string[]} */ args) => {
  let proxyPort = null;
  let dryRun = false;
  /** @type {string[]} */
  const projects = [];
  /** @type {string[]} */
  let command = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      command = args.slice(index + 1);
      break;
    }
    if (arg === "--proxy-port") {
      proxyPort = Number(args[++index]);
    } else if (arg.startsWith("--proxy-port=")) {
      proxyPort = Number(arg.slice("--proxy-port=".length));
    } else if (arg === "--project") {
      projects.push(String(args[++index] ?? ""));
    } else if (arg.startsWith("--project=")) {
      projects.push(arg.slice("--project=".length));
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`unknown jail option "${arg}"`);
    }
  }
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error(`bad --proxy-port "${proxyPort}"; expected a port`);
  }
  if (!command.length) throw new Error("jail needs a command after --");
  const cwd = process.cwd();
  const resolved = [...new Set(projects.map((project) => path.resolve(project)))];
  if (!resolved.length) throw new Error("jail needs at least one --project");
  for (const project of resolved) {
    if (!existsSync(project)) throw new Error(`no such project: ${project}`);
  }
  if (!resolved.some((project) => inside(cwd, project))) {
    throw new Error(`${cwd} is not inside a --project; list the folder with --project <dir>`);
  }
  return { proxyPort, dryRun, projects: resolved, command, cwd };
};

const jail = async (/** @type {string[]} */ args) => {
  const options = parseJailArgs(args);
  const argv = jailArgv(options.proxyPort, options.projects, options.cwd, options.command);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(argv)}\n`);
    return;
  }
  if (!existsSync(BWRAP)) {
    throw new Error("bubblewrap is missing; install it (for example: apt install bubblewrap) and run jail again");
  }
  if (!existsSync(PROXY_SOCK)) {
    throw new Error(`the proxy socket ${PROXY_SOCK} is missing; start it with "node ${SCRIPT} proxy" and run jail again`);
  }
  mkdirSync(JAIL_HOME, { recursive: true, mode: 0o700 });
  chmodSync(JAIL_HOME, 0o700);
  installLocalCredentials(JAIL_HOME, loadCredentials());
  const child = spawn(BWRAP, argv.slice(1), { stdio: "inherit" });
  forwardSignals(child);
  child.on("error", (error) => {
    say(`• ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
};

const parseJailInnerArgs = (/** @type {string[]} */ args) => {
  let proxyPort = null;
  let socket = "";
  /** @type {string[]} */
  let command = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      command = args.slice(index + 1);
      break;
    }
    if (arg === "--proxy-port") {
      proxyPort = Number(args[++index]);
    } else if (arg.startsWith("--proxy-port=")) {
      proxyPort = Number(arg.slice("--proxy-port=".length));
    } else if (arg === "--socket") {
      socket = String(args[++index] ?? "");
    } else if (arg.startsWith("--socket=")) {
      socket = arg.slice("--socket=".length);
    } else {
      throw new Error(`unknown jail-inner option "${arg}"`);
    }
  }
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error(`bad --proxy-port "${proxyPort}"; expected a port`);
  }
  if (!socket) throw new Error("jail-inner needs --socket <path>");
  if (!command.length) throw new Error("jail-inner needs a command after --");
  return { proxyPort, socket, command };
};

const claudeToken = () => {
  const file = path.join(process.env.HOME || "", ".config", "lightcode-box", "env");
  if (!existsSync(file)) return "";
  const match = /^export\s+CLAUDE_CODE_OAUTH_TOKEN=(.*)$/m.exec(readFileSync(file, "utf8"));
  return match ? unquote(match[1].trim()) : "";
};

const jailInner = async (/** @type {string[]} */ args) => {
  const options = parseJailInnerArgs(args);
  const server = net.createServer((client) => {
    client.on("error", () => undefined);
    const upstream = net.connect(options.socket);
    upstream.on("error", () => client.destroy());
    upstream.on("connect", () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.proxyPort, HOST, () => resolve(undefined));
  });
  const env = { ...process.env };
  const token = claudeToken();
  if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  const child = spawn(options.command[0], options.command.slice(1), { stdio: "inherit", env });
  forwardSignals(child);
  child.on("error", (error) => {
    say(`• ${error.message}`);
    try { server.close(); } catch {}
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    try { server.close(); } catch {}
    process.exit(signal ? 1 : code ?? 1);
  });
};

const sshCommand = (/** @type {string[]} */ args) => {
  const forwards = [];
  let proxyPort = null;
  let index = 0;
  const pathEnv = 'export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH";';
  const credsEnv = `if [ -f ${ENV_FILE} ]; then . ${ENV_FILE}; fi;`;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "--forward-proxy") {
      proxyPort = Number(args[++index]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--forward-proxy=")) {
      proxyPort = Number(arg.slice("--forward-proxy=".length));
      index += 1;
      continue;
    }
    if (arg === "--forward") {
      forwards.push(String(args[++index]));
      index += 1;
      continue;
    }
    if (arg.startsWith("--forward=")) {
      forwards.push(arg.slice("--forward=".length));
      index += 1;
      continue;
    }
    break;
  }
  let command = args.slice(index).join(" ");
  const extra = [];
  for (const forward of forwards) {
    const [remote, host] = String(forward).split(":");
    if (!Number(remote) || !Number(host)) {
      throw new Error(`bad --forward "${forward}"; expected <remotePort>:<hostPort>`);
    }
    extra.push("-R", `${Number(remote)}:127.0.0.1:${Number(host)}`);
  }
  if (proxyPort !== null) {
    if (!Number(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      throw new Error(`bad --forward-proxy port "${proxyPort}"`);
    }
    // Each session takes a remote port of its own: an idle subagent's session still holds the one
    // it took, and a second -R on the same port fails the new session (ssh exits 255).
    const remotePort = 20000 + Math.floor(Math.random() * 40000);
    extra.push("-R", `${remotePort}:127.0.0.1:${Number(proxyPort)}`);
    const url = `http://127.0.0.1:${remotePort}`;
    const env = `export HTTPS_PROXY=${url} HTTP_PROXY=${url} NO_PROXY=localhost,127.0.0.1`;
    command = `${pathEnv} ${credsEnv} ${env}; ${command || "bash -l"}`;
  } else {
    command = `${pathEnv} ${credsEnv} ${command || "bash -l"}`;
  }
  if (extra.length) extra.push("-o", "ExitOnForwardFailure=yes");
  return run("ssh", [...sshOptions(), ...extra, SSH_TARGET, command]);
};

const [command = "status", ...rest] = process.argv.slice(2);
const commands = {
  provision,
  up: () => up(rest),
  down: () => down(rest),
  reset,
  status: () => status(rest),
  creds: credsCommand,
  proxy: () => proxy(rest),
  jail: () => jail(rest),
  "jail-inner": () => jailInner(rest),
  ssh: () => {
    const end = beginSession();
    let status = 1;
    try {
      const result = sshCommand(rest);
      status = result.status ?? 1;
    } finally {
      end();
    }
    process.exit(status);
  },
};

const handler = commands[/** @type {keyof typeof commands} */ (command)];
if (!handler) {
  say(`unknown command "${command}"; one of: ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}
try {
  await handler();
} catch (error) {
  say(`• ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
