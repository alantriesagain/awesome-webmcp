# Security: agents in a box

Status: planned (2026-10-31). Phases 0 and 1 come next, after the permission and alerts fixes.

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

## Open decisions

1. A VM box's project files: a shared mount (virtiofs, live, but the agent writes files the host
   later runs: package.json scripts, hooks) or a clone the VM owns, reviewed and synced back (as
   Lima's `--sync`: https://lima-vm.io/docs/examples/ai/). Proposed: the clone for untrusted work,
   the mount for the user's own projects.
2. Whether an agent ever pushes or deploys. Proposed: never; the host's release step does.

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
