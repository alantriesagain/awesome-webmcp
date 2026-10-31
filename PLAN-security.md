# Security: agents in a box

Status: planned (2026-10-31). The VM box comes first, Task subagents in it (V1 to V3 below).

widecode starts every agent (Claude Code, opencode, Task subagents) as the user, with the user's
whole environment and file system. This plan puts what widecode starts for an agent inside a box
widecode controls, keeps production credentials out of every box, and makes a VM box double as a
staging copy of the VPS bootstrapp deploys to.

## What an agent reaches today

| Exposure | Where | What a misled agent could do |
|---|---|---|
| Cloudflare API token (`CF_API_TOKEN`, `CF_ACCOUNT_ID`) | `bootstrapp/projects/*/.env` | deploy over alantriesagain.com, meetup.rio, app.bootstrapp.ai; change D1, Workers, R2 |
| VPS key | `~/.ssh/id_rsa`, the VPS default (`bootstrapp/packages/vps/core/ssh.js`: `root@host`, `StrictHostKeyChecking=no`) | a root shell on the VPS |
| Other keys and tokens | `~/.ssh/hetzner`, `~/.ssh/caddy`, `~/.cloudflared`, wrangler's login, `meetup-rio/.env` (Play keystore, `PLAY_SERVICE_ACCOUNT_JSON`), `bootstrapp/ai-keys.local.js`, `~/.bootstrapp/vps-config.json` | use any of them |
| git push | the user's SSH key reaches `git@github.com:alantriesagain/light.git` | push, and `website/scripts/publish-pages.sh` publishes lightstart.dev |
| No permission checks | Claude starts with `--permission-mode bypassPermissions` (`plugins/claude.ts`); opencode allows most tools by default and does not sandbox (its SECURITY.md) | run anything without asking |
| The whole environment | `@light/lib/process.ts` spawns without `env`, so every agent inherits widecode's | read any token in it |
| Harness and hooks run on the host | `.widecode/config.json` (`worktreeSetup`, an agent's `command`), `.widecode/plugins/*.js` (reload on save, `api.process.spawn`), `.git/hooks` | plant a command the host runs later, outside every agent's permissions |
| widecode's MCP server | 127.0.0.1 with a bearer token in a file the agent can read | call widecode's tools (Task, worktrees) directly |

Claude Code's own sandbox is a reference, not the plan: it covers Bash and its children only (Read,
Edit, MCP servers and hooks run outside it) and leaves `~/.ssh` readable by default
(https://code.claude.com/docs/en/sandboxing).

## The box

Every process widecode starts for an agent goes through the runtime's `spawnProcess` and
`runProcess`. A box profile there wraps each command in a launcher, for the agents, Task
subagents, worktree setup lines and project plugins' commands alike (the built-in plugins' own
commands, such as git for the tree, stay on the host).

1. Local box, bubblewrap, for everyday work. Tested on this machine: it runs unprivileged (Mint 22
   has `apparmor_restrict_unprivileged_userns` 0), hides the home folder (`--tmpfs ~`) and cuts the
   network (`--unshare-net`); it needs `--dev /dev`. The project is mounted read-write, a fresh home
   holds only the agent's own login, and network access goes through a proxy widecode runs that
   allows a list of domains: the model APIs (`api.anthropic.com`, `claude.ai`,
   `platform.claude.com`, opencode's provider), npm, GitHub. opencode honors `HTTPS_PROXY`
   (https://opencode.ai/docs/network/), Claude Code too (https://code.claude.com/docs/en/network-config).
   Startup is a process's.
2. VM box, libvirt and qemu (installed; `/dev/kvm` present), for untrusted work. Claude Code's
   stream-json and ACP are stdio protocols, so widecode runs `ssh <vm> claude -p ...` and
   `ssh <vm> opencode acp` with the adapters unchanged; widecode's MCP server reaches the VM over
   `ssh -R`. The image starts from bootstrapp's VPS test VM (`packages/vps/testvm/`: Debian 13
   cloud-init, Docker, Compose, sqlite3, rsync, the `bootstrapp-net` network, SSH on 2222, HTTP on
   8080), so the box is also the staging environment: `deploySite` targets the VM's Caddy as it
   targets the VPS's. About 4 GB of the machine's 15 GB. Egress: nftables on the VM's bridge allows
   only the host proxy; the proxy holds the domain list.

### Rules in every box

- No production credential enters a box. The box gets its own model credential (a
  `claude setup-token` OAuth token, opencode's provider key), and the environment is built for the
  box rather than inherited.
- No push and no deploy from a box. widecode shows the change, the user approves, and the host
  commits, pushes and deploys (the release step); production tokens are used there alone. An agent
  that must push gets a per-repository deploy key or a fine-grained token with an expiry, never the
  user's key, and never ssh-agent forwarding.
- The box cannot widen itself: `.widecode/`, `.claude/settings*.json`, `.git/config` and
  `.git/hooks` are read-only inside it. A harness change the agent proposes is applied on the host
  once the user approves it.
- Inside a box, Claude may keep `bypassPermissions`: the box is the boundary. Outside one, widecode
  starts it asking.

## Phases

0. No code, about an hour, with the user's go-ahead (it changes files and keys outside widecode):
   move `CF_API_TOKEN` and the Play keys out of the repositories' `.env` into a host-only store
   that only the deploy commands read; give the VPS a non-root deploy user with a key of its own,
   and stop using `~/.ssh/id_rsa` for it (and turn host key checking on); opencode rules denying
   `external_directory` and `.env` reads; Claude deny rules for `Read(~/.ssh/**)` and `**/.env*`
   (honored under `bypassPermissions`).
1. The box with the bubblewrap backend: the launcher in the runtime, a box profile per project in
   config, the environment built for the box, the domain proxy, and the read-only harness and git
   paths. Task subagents first (deepseek is the most exposed), then the main agent.
2. The VM backend from bootstrapp's test VM: agents over ssh stdio, the MCP server over `ssh -R`,
   staging deploys to the VM.
3. The model credential injected by the proxy so it never enters the box (as Docker Sandboxes and
   E2B do: https://docs.docker.com/ai/sandboxes/security/, https://docs.e2b.dev/secrets.md), and
   the release step built into widecode.

## Decisions

1. A VM box's project files: a shared mount, so widecode's tree and code column follow the agent's
   edits live; `.widecode/`, `.claude/` and `.git/hooks` read-only inside the VM. (A clone the VM
   owns, reviewed and synced back as Lima's `--sync` does, stays possible for untrusted repositories
   later: https://lima-vm.io/docs/examples/ai/.)
2. Task subagents go into the VM first; the main agent stays on the host until they run well there.
3. Whether an agent ever pushes or deploys. Proposed: never; the host's release step does.

## The VM box, step by step

The VM comes first, ahead of the bubblewrap box: it is the stronger boundary and it doubles as
staging. It follows bootstrapp's test VM (`packages/vps/testvm/vm.mjs`): plain QEMU as the user,
no root, a Debian 13 cloud image (cached under `~/.cache/bootstrapp/vps-test/`) as the read-only
base, and a qcow2 overlay per box, so a reset is a new overlay and nothing drifts.

- Network: QEMU user-mode networking with `restrict=on`, so the guest reaches nothing outside; one
  `hostfwd` brings SSH in on 127.0.0.1. Provisioning (apt, the agents' installers) runs once with
  the network open and makes the box's base image; every run after it is restricted.
- Egress and widecode's tools: each agent runs in its own SSH session, and that session carries
  `-R` forwards to a proxy on the host that allows a list of domains, and to widecode's MCP server
  (its port changes each run, which `-R` follows). Inside, `HTTPS_PROXY` points at the forward.
- Files: the project shared by 9p (`-virtfs`, no extra install; virtiofs needs `virtiofsd`) at the
  same path as on the host, so a cwd and a transcript's paths mean the same on both sides. At boot,
  root bind-mounts `.widecode/`, `.claude/` and `.git/hooks` read-only over the share; the agent's
  user has no sudo.
- Agents: Claude Code and opencode installed in the image by their own installers (the user's
  CLIs, as widecode runs today), run as `ssh box -- opencode acp` and `ssh box -- claude -p ...`:
  the same stdio protocols, so the adapters do not change. The VM's credentials are its own: a
  `claude setup-token` token and an opencode key made for the box, never the host's files.
- Staging: the same image runs Docker and Caddy as bootstrapp's VPS does, and bootstrapp's
  `deploySite` deploys into it (`VPS_HOST=127.0.0.1` and the forwarded port, the box's key), from
  the host.

Steps:

- V1, a spike in `apps/widecode/box/` (node scripts, development tooling): build the base image,
  boot a box restricted, share a project, mount the read-only paths, reach it over SSH, and check
  that an `-R` proxy forward lets an allowed domain through and refuses another, and that
  `opencode acp` answers `initialize` over the SSH session.
- V2, the agents through it: the box's credentials (the user makes them), a model call from both
  agents, widecode's MCP tools over `-R`.
- V3, widecode: a box in a project's config; the runtime runs a Task subagent's command through
  `ssh box`; the box started and stopped with widecode; the proxy kept by widecode.
- V4, the main agent in the box (its transcripts read from a folder the box writes to), then
  staging deploys.

## Sources

The research behind this plan: opencode's permissions (https://opencode.ai/docs/permissions/, ACP
mapping in `packages/opencode/src/acp/permission.ts`), bubblewrap
(https://github.com/containers/bubblewrap), Anthropic's sandbox runtime
(https://github.com/anthropics/sandbox-runtime) and dev container
(https://code.claude.com/docs/en/devcontainer), Incus containers and VMs
(https://linuxcontainers.org/incus/docs/main/explanation/containers_and_vms/), libvirt virtiofs
(https://libvirt.org/kbase/virtiofs.html), Docker Sandboxes
(https://docs.docker.com/ai/sandboxes/architecture/), E2B's egress
(https://docs.e2b.dev/sandbox/internet-access.md), GitHub deploy keys and tokens
(https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys).
