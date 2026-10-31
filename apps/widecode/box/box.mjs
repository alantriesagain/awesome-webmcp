#!/usr/bin/env node
/**
 * A development spike for the VM box in PLAN-security.md (V1).
 *
 * Plain QEMU as the user, no root, as bootstrapp's packages/vps/testvm/vm.mjs
 * does: a Debian 13 cloud image as the read-only backing file, a qcow2 overlay
 * per box, a cloud-init seed ISO built with genisoimage, user-mode networking
 * with one hostfwd for SSH, a pid file and a console log.
 *
 * There is one box. `up` takes every project the box shares, each by its own
 * 9p tag at its own host path, and keeps the list in the state dir. A second
 * `up` with the same list is a no-op; with a different list it says to restart
 * the box. A lock and the QEMU pid file keep a second VM from starting.
 *
 * `provision` boots once with the network open and builds base.qcow2: the
 * `agent` user (no sudo), git, ripgrep, curl, ca-certificates, Claude Code and
 * opencode from their own installers. `up` boots a fresh overlay on base with
 * restrict=on. A per-boot cloud-init seed mounts the shares and bind-mounts
 * .widecode, .claude and .git/hooks read-only, because the project paths change
 * per boot.
 *
 * `proxy` is a host-side HTTP(S) proxy on loopback with a domain allow list.
 * `ssh` can forward it (`--forward-proxy`) and other host ports (`--forward`)
 * into the restricted guest, and points the remote command's HTTPS_PROXY at it.
 *
 * Usage:
 *   node box.mjs provision
 *   node box.mjs up <folder> [<folder>...]
 *   node box.mjs ssh [--forward-proxy <port>] [--forward <remotePort>:<hostPort>]... [--] [cmd...]
 *   node box.mjs proxy [--port N] [--allow domain,...]
 *   node box.mjs creds
 *   node box.mjs down | status | reset
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const STATE = process.env.WIDECODE_BOX_DIR || path.join(os.homedir(), ".cache", "widecode", "box");
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
const PROXY_PID = path.join(STATE, "proxy.pid");
const PROXY_LOG = path.join(STATE, "proxy.log");

const ENV_DIR = "/home/agent/.config/widecode-box";
const ENV_FILE = `${ENV_DIR}/env`;
const OPENCODE_AUTH = "/home/agent/.local/share/opencode/auth.json";
const CREDENTIAL_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "OPENCODE_API_KEY"];

const credentialsPath = () =>
  process.env.WIDECODE_BOX_CREDENTIALS || path.join(os.homedir(), ".widecode", "box", "credentials.env");

const HOST = "127.0.0.1";
const PORT = Number(process.env.WIDECODE_BOX_PORT || 2223);
const MEMORY = process.env.WIDECODE_BOX_MEMORY || "4096";
const CPUS = process.env.WIDECODE_BOX_CPUS || "4";
const READY = "/run/widecode-box-ready";

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

const say = (/** @type {string} */ msg) => process.stderr.write(`${msg}\n`);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

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
  must("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "widecode-box", "-f", KEY]);
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
    `instance-id: ${userData.match(/^instance-id: (.+)$/m)?.[1] ?? "widecode-box"}\nlocal-hostname: widecode-box\n`,
  );
  rmSync(file, { force: true });
  must("genisoimage", [
    "-quiet", "-output", file, "-volid", "cidata", "-joliet", "-rock",
    path.join(STATE, "user-data"), path.join(STATE, "meta-data"),
  ]);
};

/** @param {string} disk @param {string} seed @param {{ restrict: boolean, projects?: string[] }} opts */
const boot = async (disk, seed, { restrict, projects = [] }) => {
  rmSync(CONSOLE, { force: true });
  rmSync(MONITOR, { force: true });
  const netdev = restrict
    ? `user,id=n0,restrict=on,hostfwd=tcp:${HOST}:${PORT}-:22`
    : `user,id=n0,hostfwd=tcp:${HOST}:${PORT}-:22`;
  const qemu = spawn(QEMU, [
    "-enable-kvm",
    "-cpu", "host",
    "-m", MEMORY,
    "-smp", CPUS,
    "-drive", `file=${disk},if=virtio,format=qcow2`,
    "-drive", `file=${seed},if=virtio,format=raw,readonly=on`,
    "-netdev", netdev,
    "-device", "virtio-net-pci,netdev=n0",
    ...projects.flatMap((project, index) => [
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
  return { file, present: true, values };
};

const credentialSummary = (/** @type {{ values: Record<string, string> }} */ creds) =>
  `claude ${creds.values.CLAUDE_CODE_OAUTH_TOKEN ? "set" : "empty"}, ` +
  `opencode-go ${creds.values.OPENCODE_API_KEY ? "set" : "empty"}`;

const installCredentials = (/** @type {{ values: Record<string, string> }} */ creds) => {
  const claude = creds.values.CLAUDE_CODE_OAUTH_TOKEN || "";
  const opencode = creds.values.OPENCODE_API_KEY || "";
  const script = `#!/bin/bash
set -e
umask 077
mkdir -p ${ENV_DIR}
chmod 700 ${ENV_DIR}
${claude
    ? `printf 'export CLAUDE_CODE_OAUTH_TOKEN=%s\\n' ${shq(claude)} > ${ENV_FILE}
chmod 600 ${ENV_FILE}`
    : `rm -f ${ENV_FILE}`}
mkdir -p /home/agent/.local/share/opencode
WIDECODE_BOX_OPENCODE_KEY=${shq(opencode)} python3 - <<'PY'
import json
import os
path = ${JSON.stringify(OPENCODE_AUTH)}
try:
    with open(path) as handle:
        data = json.load(handle)
except (FileNotFoundError, ValueError):
    data = {}
key = os.environ.get("WIDECODE_BOX_OPENCODE_KEY", "")
if key:
    data["opencode-go"] = {"type": "api", "key": key}
else:
    data.pop("opencode-go", None)
with open(path, "w") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\\n")
os.chmod(path, 0o600)
PY
`;
  const result = ssh("bash -s", { quiet: true, input: script, timeout: 30000 });
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim() || `ssh exited ${result.status}`;
    throw new Error(`installing credentials failed: ${detail}`);
  }
};

const provisionUserData = (/** @type {string} */ pub) => `#cloud-config
hostname: widecode-box
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

write_files:
  - path: /usr/local/bin/widecode-box-agents
    permissions: '0755'
    content: |
      #!/bin/bash
      set -e
      export DEBIAN_FRONTEND=noninteractive
      CLOUD=$(dpkg -l 'linux-image-*cloud-amd64' | awk '/^ii/ {print $2}')
      if [ -n "$CLOUD" ]; then apt-get purge -y $CLOUD; fi
      update-grub
      runuser -l agent -c 'curl -fsSL https://claude.ai/install.sh | bash'
      runuser -l agent -c 'curl -fsSL https://opencode.ai/install | bash'

runcmd:
  - [ /usr/local/bin/widecode-box-agents ]
instance-id: widecode-box-provision
`;

const upUserData = (/** @type {string[]} */ projects) => {
  const script = `#!/bin/bash
set -e
${projects
  .map(
    (project, index) => `mkdir -p ${shq(project)}
mount -t 9p -o trans=virtio,version=9p2000.L project${index} ${shq(project)}
for rel in .widecode .claude .git/hooks; do
  src=${shq(project)}/"$rel"
  if [ -e "$src" ]; then
    mount --bind "$src" "$src"
    mount -o remount,bind,ro "$src"
  fi
done`,
  )
  .join("\n")}
touch ${READY}
`;
  return `#cloud-config
hostname: widecode-box
disable_root: true
ssh_pwauth: false
ssh_deletekeys: false

write_files:
  - path: /usr/local/bin/widecode-box-setup
    permissions: '0755'
    content: |
${yamlBlock(script)}
runcmd:
  - [ /usr/local/bin/widecode-box-setup ]
instance-id: widecode-box-up-${Date.now()}
`;
};

const agentProbe = [
  'export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$PATH"',
  'for c in claude opencode; do',
  '  p=$(command -v "$c") || { echo "$c: not found"; continue; }',
  '  echo "$c: $p"',
  '  "$c" --version 2>&1 | head -1',
  'done',
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
    must(QEMU_IMG, ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", source, BASE, "20G"]);
    const seed = path.join(STATE, "seed-provision.iso");
    buildSeed(seed, provisionUserData(pub));
    say(`• provisioning (${MEMORY}MB, ${CPUS} vcpu), network open`);
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

const up = async (/** @type {string[]} */ folders) => {
  if (!folders.length) throw new Error("up needs at least one project folder");
  if (!existsSync(BASE)) throw new Error("no base.qcow2; run provision first");
  const projects = folders.map((folder) => path.resolve(folder));
  for (const project of projects) {
    if (!existsSync(project)) throw new Error(`no such folder: ${project}`);
  }
  if (new Set(projects).size !== projects.length) throw new Error("a folder is listed twice");
  const creds = loadCredentials();
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
    must(QEMU_IMG, ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", BASE, BOX, "20G"]);
    const seed = path.join(STATE, "seed-up.iso");
    buildSeed(seed, upUserData(projects));
    say(`• booting restricted, ${projects.length} project(s) on 9p, ssh on ${HOST}:${PORT}`);
    for (const [index, project] of projects.entries()) say(`• project${index}: ${project}`);
    const started = Date.now();
    await boot(BOX, seed, { restrict: true, projects });
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
    const next = { ...record(), projects, upAt: new Date().toISOString(), sshSeconds };
    delete next.project;
    saveRecord(next);
    say(`• up; ssh -i ${KEY} -p ${PORT} ${SSH_TARGET}`);
  } finally {
    releaseLock();
  }
};

const down = async () => {
  acquireLock();
  try {
    await stopProxy();
    if (!pid()) {
      say("• not running");
      return;
    }
    await powerdown();
  } finally {
    releaseLock();
  }
};

const reset = async () => {
  acquireLock();
  try {
    await stopProxy();
    if (pid()) await powerdown();
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

const status = () => {
  const running = pid();
  const saved = record();
  const projects = Array.isArray(saved.projects)
    ? saved.projects
    : typeof saved.project === "string"
      ? [saved.project]
      : [];
  const proxy = proxyPid();
  say(`pid:       ${running ?? "not running"}`);
  say(`ssh:       ${running && reachable() ? `${HOST}:${PORT}` : "unreachable"}`);
  say(`proxy:     ${proxy ? `running (pid ${proxy}, log ${PROXY_LOG})` : "not running"}`);
  say(`projects:  ${running && projects.length ? projects.join(", ") : projects.length ? `${projects.join(", ")} (last)` : "none"}`);
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
  let port = Number(process.env.WIDECODE_BOX_PROXY_PORT || 8888);
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

  const server = http.createServer((req, res) => {
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
  });

  server.on("connect", (req, clientSocket, head) => {
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
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve(undefined));
  });
  writeFileSync(PROXY_PID, String(process.pid));
  logProxy(`started on ${HOST}:${port}, allow ${allow.join(",")}`);
  say(`• proxy listening on http://${HOST}:${port}`);
  say(`• allow: ${allow.join(", ")}`);
  say(`• log: ${PROXY_LOG}`);
  const stop = () => {
    try { server.close(); } catch {}
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
    extra.push("-R", `${Number(proxyPort)}:127.0.0.1:${Number(proxyPort)}`);
    const url = `http://127.0.0.1:${Number(proxyPort)}`;
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
  down,
  reset,
  status,
  creds: credsCommand,
  proxy: () => proxy(rest),
  ssh: () => {
    const result = sshCommand(rest);
    process.exit(result.status ?? 1);
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
