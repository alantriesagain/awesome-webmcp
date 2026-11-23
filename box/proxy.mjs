#!/usr/bin/env node
/**
 * The host-side HTTP(S) proxy for widecode's box, the one a project's box config gives an allow
 * list to. It listens on loopback and on <state>/proxy.sock, uses the same pid, socket and log files
 * as `box.mjs proxy`, and handles plain HTTP and CONNECT: a host is allowed when the list has `*`,
 * when it equals an entry, when it is a subdomain of a `*.domain` entry, or when `--allow-local`
 * names its port and it is 127.0.0.1 (widecode's MCP server, offered to a boxed subagent for its
 * host actions). The defaults are `box.mjs`'s, with the project's entries added: `--allow` replaces
 * them, `--allow-extra` adds to them.
 *
 * Usage:
 *   node box/proxy.mjs proxy [--port N] [--allow domain,...] [--allow-extra domain,...] [--allow-local N]
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const STATE = process.env.WIDECODE_BOX_DIR || path.join(os.homedir(), ".cache", "widecode", "box");
const PROXY_PID = path.join(STATE, "proxy.pid");
const PROXY_LOG = path.join(STATE, "proxy.log");
const PROXY_SOCK = path.join(STATE, "proxy.sock");
const HOST = "127.0.0.1";

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

const say = (/** @type {string} */ msg) => process.stderr.write(`${msg}\n`);

const alive = (/** @type {number} */ value) => {
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
};

const proxyPid = () => {
  if (!existsSync(PROXY_PID)) return null;
  const value = Number(readFileSync(PROXY_PID, "utf8").trim());
  return value && alive(value) ? value : null;
};

const listOf = (/** @type {string} */ value) => value.split(",").map((entry) => entry.trim()).filter(Boolean);

const hostAllowed = (/** @type {string} */ host, /** @type {string[]} */ allow) => {
  if (allow.includes("*")) return true;
  const name = host.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => {
    const pattern = entry.toLowerCase();
    if (pattern.startsWith("*.")) return name.endsWith(`.${pattern.slice(2)}`);
    return name === pattern;
  });
};

/** Whether `host:port` is the local MCP server the run may reach. */
const localAllowed = (/** @type {string} */ host, /** @type {number} */ port, /** @type {number} */ localPort) =>
  localPort > 0 && (host === HOST || host === "localhost") && port === localPort;

const logProxy = (/** @type {string} */ line) => {
  mkdirSync(STATE, { recursive: true });
  appendFileSync(PROXY_LOG, `${new Date().toISOString()} ${line}\n`);
};

const proxy = async (/** @type {string[]} */ args) => {
  let port = Number(process.env.WIDECODE_BOX_PROXY_PORT || 8888);
  let allow = DEFAULT_ALLOW;
  let localPort = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      port = Number(args[++index]);
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--allow") {
      allow = listOf(String(args[++index] ?? ""));
    } else if (arg.startsWith("--allow=")) {
      allow = listOf(arg.slice("--allow=".length));
    } else if (arg === "--allow-extra") {
      allow = [...allow, ...listOf(String(args[++index] ?? ""))];
    } else if (arg.startsWith("--allow-extra=")) {
      allow = [...allow, ...listOf(arg.slice("--allow-extra=".length))];
    } else if (arg === "--allow-local") {
      localPort = Number(args[++index]);
    } else if (arg.startsWith("--allow-local=")) {
      localPort = Number(arg.slice("--allow-local=".length));
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
    const local = localAllowed(target.hostname, Number(target.port || 80), localPort);
    if (!local && !hostAllowed(target.hostname, allow)) {
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
    const local = localAllowed(host, targetPort, localPort);
    if (!local && !hostAllowed(host, allow)) {
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
  logProxy(`started on ${HOST}:${port} and ${PROXY_SOCK}, allow ${allow.join(",")}${localPort > 0 ? ", local " + String(localPort) : ""}`);
  say(`• proxy listening on http://${HOST}:${port} and ${PROXY_SOCK}`);
  say(`• allow: ${allow.join(", ")}${localPort > 0 ? ", 127.0.0.1:" + String(localPort) : ""}`);
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

const [command = "proxy", ...rest] = process.argv.slice(2);
if (command !== "proxy") {
  say(`unknown command "${command}"; box/proxy.mjs takes proxy`);
  process.exit(2);
}
try {
  await proxy(rest);
} catch (error) {
  say(`• ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
