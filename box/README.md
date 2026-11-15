# widecode's box (spike)

The box has two backends: a Debian 13 VM and a bubblewrap jail on the host. The jail is the lighter
one, with no VM memory cost. Both are built and driven by node
scripts with no dependencies.

The VM follows bootstrapp's test VM (`packages/vps/testvm/vm.mjs`): QEMU runs as the user, the Debian
cloud image is a read-only backing file, each box is a fresh qcow2 overlay, cloud-init comes in on a
genisoimage seed ISO, networking is user-mode with one hostfwd, and the state is a pid file plus a
console log.

There is one VM. It shares every project `up` lists, each at its own host path, so every agent in
every project uses the same guest. A lock file and the QEMU pid file keep a second VM from starting.

State lives in `~/.cache/widecode/box/` (override with `WIDECODE_BOX_DIR`). The cached image at
`~/.cache/bootstrapp/vps-test/debian-13-genericcloud-amd64.qcow2` is used as the backing file when it
exists; otherwise the image is downloaded into the box's own state directory. The box has its own
SSH key under `~/.cache/widecode/box/id_ed25519` and its own `known_hosts`.

## Commands

```
node box/box.mjs provision
node box/box.mjs up [--memory <MB>] [--cpus <n>] [--port <host>[:<guest>]]... <folder> [<folder>...]
node box/box.mjs ssh [--forward-proxy <port>] [--forward <remotePort>:<hostPort>]... [--] [cmd...]
node box/box.mjs proxy [--port N] [--allow domain,...]
node box/box.mjs jail --proxy-port <port> [--project <dir>]... [--dry-run] -- <cmd...>
node box/box.mjs creds
node box/box.mjs down [--if-idle]
node box/box.mjs status [--json]
node box/box.mjs reset
```

`provision` builds `base.qcow2`, an overlay on the cached Debian image resized to 40 GB, and boots it
once with the network open. Cloud-init creates the `agent` user (shell, the box's public key, no
sudo), installs git, ripgrep, curl, ca-certificates, `linux-image-amd64`, `build-essential`,
`clang`, `xz-utils` and `cloud-guest-utils`, installs node 24 from the official tarball
(`https://nodejs.org/dist/latest-v24.x`, extracted into `/usr/local`), installs pnpm 10.11.0 from
npm, and runs Claude Code's and opencode's own installers as `agent`. Node scripts in the guest
therefore run under the same node 24 the compiler is built for, and clang is the linker scriptc's
executable builds drive. It then reports the paths and versions over SSH and powers the guest down
through the QEMU monitor, leaving `base.qcow2` provisioned. Cloud-init's growpart grows the guest's
root to the 40 GB disk on boot; `df -h /` in the guest reported 40 GB.

`up` creates a fresh `box.qcow2` overlay on `base.qcow2` and boots it with
`-netdev user,id=n0,restrict=on,hostfwd=tcp:127.0.0.1:2223-:22`, 4096 MB and 4 CPUs by default
(`--memory`, `--cpus`, or `WIDECODE_BOX_MEMORY` / `WIDECODE_BOX_CPUS`) and KVM. `--port` adds a
`hostfwd` on `127.0.0.1` for each pair, guest port equal to host port when only one is given; it is
repeatable. bootstrapp's dev ports are the usual set, for example:

```
node box/box.mjs up --port 2100 --port 3400 --port 3500 --port 3530 --port 3600 \
  --port 3700 --port 3900 --port 4000 --port 4100 --port 4200 <folder>...
```

Each folder is shared with its own tag (`project0`, `project1`, ...) at its own absolute host path.
When `/usr/libexec/virtiofsd` (1.10 here) exists, `up` runs one virtiofsd per project as the user,
unprivileged, with a socket in the state directory and mounts `-t virtiofs <tag> <same path>` in the
guest. QEMU gets a shared memfd backend (`-object
memory-backend-memfd,id=mem,size=<memory>M,share=on -numa node,memdev=mem`) and one
`vhost-user-fs-pci` device per project. virtiofsd maps the guest's file operations onto the host user
when it runs unprivileged, so files the guest creates keep the host user's ownership. `down` stops
every virtiofsd it recorded in `virtiofsd.json`. When virtiofsd is missing, `up` falls back to 9p
(`-virtfs local,path=<project>,mount_tag=<tag>,security_model=none`) and says so. `up` also says
which one it used; `WIDECODE_BOX_SHARES=9p` (or `virtiofs`) forces one for a comparison.

The virtiofsd sandbox is `namespace` when `newuidmap` is on the host, else `none`. This host has no
`newuidmap` (the `uidmap` package), so the namespace sandbox failed with
`sandbox: couldn't setup id mappings ... newuidmap: No such file or directory` and the spike ran with
`--sandbox none`; seccomp still runs with `--seccomp kill`. Install `uidmap` to get the namespace
sandbox.

A per-boot cloud-init seed, rather than a unit baked into the image, mounts each share and
bind-mounts `.widecode/`, `.claude/` and `.git` read-only over it when they exist, because the
project paths change per boot. The seed runs once, at boot, so a task's worktree made later is not
covered in the VM; the jail covers it (below). The seed also mounts the host's `<state>/guest-cache` over
`/home/agent/.cache` and gives it to `agent`, so the guest's scriptc cache lasts across `down` and
`up`. `up` waits for SSH and for the `/run/widecode-box-ready` marker the seed writes, and saves the
project list, the share kind, memory, CPUs and ports in `box.json`. A second `up` with the same list
returns at once; with a different list it refuses and says to run `down`, then `up`.

### scriptc and the build cache

The guest uses the scriptc installed in the shared checkout's `node_modules`, which
`light` resolves from the workspace root. The widecode checkout is shared at its own host
path, so `/home/alanleal/Projects/widecode/node_modules/.bin/scriptc` exists in the guest. Its
cache lives under the guest's `/home/agent/.cache`, which is the host folder
`<state>/guest-cache`. A host-shared cache would let the box plant a build the host then runs, so
the folder is the box's alone: only the guest has it, and the host's own scriptc cache lives
elsewhere and never reads it. The shared projects are `/home/alanleal/Projects/{widecode,light}`,
so `widecode/light` (a symlink to `../light`) resolves inside the guest when light is shared at its
own path.

`proxy` is a host-side HTTP proxy on `127.0.0.1` (default port 8888, override with `--port` or
`WIDECODE_BOX_PROXY_PORT`) and on `<state>/proxy.sock`. Both listeners use the same allow list and
write the same log lines. It handles plain HTTP and `CONNECT`, allows a host that equals an entry in
`--allow` (comma-separated, default: `api.anthropic.com`, `claude.ai`, `platform.claude.com`,
`claude.com`, `statsig.anthropic.com`, `opencode.ai`, `*.opencode.ai`, `registry.npmjs.org`,
`github.com`, `*.github.com`, `*.githubusercontent.com`) or is a subdomain of a `*.domain` entry, and
answers 403 to everything else. It logs every allowed and refused request to `proxy.log` in the state
directory, writes its pid to `proxy.pid`, and runs until `down` or a signal stops it. It removes a
stale socket before listening, sets the new one to mode 600, and removes it when it stops.

`ssh` runs as `agent` with the box key, `BatchMode=yes` and the box's own `known_hosts`. It puts
`~/.local/bin` and `~/.opencode/bin` first on the remote `PATH`, so `claude` and `opencode` resolve
without a login shell, and sources `/home/agent/.config/widecode-box/env` when it exists, so the
Claude token is set for every session. `--forward-proxy <port>` adds `-R <port>:127.0.0.1:<port>` and exports
`HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY=localhost,127.0.0.1` in the remote command; `--forward
<remotePort>:<hostPort>` adds `-R <remotePort>:127.0.0.1:<hostPort>` and may be repeated. Forwards use
`ExitOnForwardFailure=yes`. While an `ssh` runs it keeps `<state>/sessions/<pid>` and removes the file
when it ends. `down --if-idle` stops the box only when no live session remains, after removing files
whose pid is gone; otherwise it prints `the box is in use by <n> session(s)` and leaves the box
running, so several widecode windows can share one VM. Plain `down` always stops it. `down` stops the
proxy, asks for an ACPI powerdown through the QEMU monitor and terminates the process after 45 seconds
if the guest does not leave. `reset` drops `box.qcow2`; `base.qcow2` is kept.

## The jail

`jail` is the lighter backend. It runs a command under `/usr/bin/bwrap` with the caller's cwd and
passes stdin, stdout and stderr through, so ACP carries its JSON-RPC over stdio. It exits with the
command's code, forwards SIGTERM and SIGINT, and bwrap's `--die-with-parent` ends the sandbox with
its parent.

If bubblewrap or `<state>/proxy.sock` is missing, it exits 1 with one line naming the missing piece
and how to fix it. `--dry-run` prints the bwrap argv as one JSON line and exits 0, without running it
or touching credentials. Tests use it.

The sandbox has `--unshare-all` (a network namespace with only loopback), `--die-with-parent`,
`--new-session`, `/proc`, `/dev` and a tmpfs `/tmp`. `/usr` and `/etc` are read-only; `/bin`, `/lib`,
`/lib64` and `/sbin` are recreated as on the host, as symlinks into `usr` on a merged-usr host and
read-only binds otherwise. It sees no host home beyond the jail home and the tool folders, no
`/run`, `/var`, `/media` or `/mnt`.

The jail home is `<state>/jail-home` (mode 700). It is bound read-write at the host user's real home
path, so absolute paths under home keep working. It holds the jail's own opencode data, scriptc's
cache and pnpm's store. scriptc itself comes from the workspace root's `node_modules`, which the
jail binds read-write with the project.

Each tool found on the host `PATH` among `node`, `pnpm`, `opencode` and `claude` is read-only at
its host path, after resolving symlinks: the whole nvm version folder for node under nvm, and
`~/.opencode/bin` for opencode. `box.mjs` itself is read-only too. Each `--project` is read-write
at its own path, with `.widecode/`, `.claude/` and `.git` read-only over it when they exist. The
cwd must be inside a project.

`.git` is read-only whole because the host's git runs what it says: `config` (`core.fsmonitor`,
`core.hooksPath`), a `commondir` file, which moves where git reads its config from, and the hooks.
Inside the jail `git status`, `diff`, `log` and `grep` work; `add`, `commit` and `stash` fail, since
they write the index. Each protected path is a mount point, so it cannot be renamed away and replaced
by a folder the jail made. A task's worktree under `<project>/.worktrees/<name>` has a `.git` file
naming its git dir: `.worktrees` and each worktree with a `.git` are bound onto themselves, which
keeps them from being renamed, and the worktree's `.widecode/`, `.claude/` and `.git` are read-only
as the project's are. A live check renamed `.git`, `.worktrees` and a worktree, wrote `.git/config`,
`.git/commondir` and a worktree's `.git`, and removed `.git/HEAD`: each failed with `Read-only file
system` or `Device or resource busy`.

The proxy socket is bound at its state path. The environment is cleared and gets `HOME`, `USER`,
`PATH` (the tool folders and `/usr/local/bin:/usr/bin:/bin`), `LANG`, `TERM`, `HTTPS_PROXY`,
`HTTP_PROXY`, `https_proxy` and `http_proxy` at `http://127.0.0.1:<port>`, and
`NO_PROXY=localhost,127.0.0.1`.

Inside, bwrap runs `node box.mjs jail-inner --proxy-port <port> --socket <path> -- <cmd...>`. That
part listens on `127.0.0.1:<port>`, pipes each connection to the proxy socket, reads
`~/.config/widecode-box/env` from the jail home and adds `CLAUDE_CODE_OAUTH_TOKEN` to the child's
environment when it is set, then starts the command.

Before starting bwrap, `jail` writes the jail home's `.config/widecode-box/env` (mode 600) and
merges the `opencode-go` entry into `.local/share/opencode/auth.json` (mode 600), from
`~/.widecode/box/credentials.env`, using the same reader, checks and merge as `up`. An empty value
removes the file or entry. Values never go on a command line and are never printed.

## Credentials

The box's credentials are a file on the host, `~/.widecode/box/credentials.env` (override with
`WIDECODE_BOX_CREDENTIALS`). It has one `KEY=value` per line, `#` comments and blank lines. The keys
are `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) and `OPENCODE_API_KEY` (a key for the
`opencode-go` provider). An empty value means that agent gets no credential. The file must be mode
600, its folder mode 700, and both owned by the user; `up` and `creds` refuse anything else with a
message naming the path and the fix. Values are never printed or put on a command line: `up` sends
an install script to the guest over SSH stdin.

What `up` installs after SSH answers:

- Claude: `/home/agent/.config/widecode-box/env` (folder mode 700, file mode 600) with
  `export CLAUDE_CODE_OAUTH_TOKEN=...`. Every `box.mjs ssh` session sources that file before the
  remote command, beside the proxy variables. An empty value removes the file.
- opencode: an entry in `/home/agent/.local/share/opencode/auth.json` (mode 600):
  `{"opencode-go":{"type":"api","key":"..."}}`, merged with any other provider entries already
  there. An empty value removes that entry. This is opencode's own credential store, the file its
  `/connect` command writes (https://opencode.ai/docs/providers/), so the CLI needs no extra
  environment. The provider also reads `OPENCODE_API_KEY` from the environment, but that would make
  every agent session export it; the store is the mechanism the CLI itself uses. `opencode auth
  login` prompts on a TTY and does not take a piped key, so the file is written directly.

The `creds` command prints whether each key is set or empty in the file and, when the box runs,
whether Claude has the token and whether opencode has the `opencode-go` entry. It never prints a
value.

Each value is checked for its shape when the file is read: `CLAUDE_CODE_OAUTH_TOKEN` must start
with `sk-ant-oat01-` and hold only `[A-Za-z0-9_-]`, and `OPENCODE_API_KEY` must hold no whitespace
and no `#`. A value that does not is refused with its key and what is wrong, never the value.

`status --json` prints one line with whether the box runs, its projects and whether its proxy runs,
so widecode can decide what to start before a task runs in it.

The hosts each agent needs are already in the proxy's default allow list, so this spike added none.
The proxy log from a model call showed Claude reaching only `api.anthropic.com`. opencode reached
`opencode.ai` (its inference API), `models.opencode.ai` (the model catalog, covered by
`*.opencode.ai`) and `registry.npmjs.org` (its provider package). No request was refused.

## What the checks found

Tested on a scratch git repository at `/tmp/wc-box-scratch` with `file.txt`, `.widecode/config.json`,
`.claude/settings.json` and `.git/hooks`.

1. `provision` completed and reported:
   ```
   claude: /home/agent/.local/bin/claude
   2.1.316 (Claude Code)
   opencode: /home/agent/.opencode/bin/opencode
   1.19.5
   ```
   Boot to SSH was 8 seconds; package installation and the two agent installers took the rest of the
   command.
2. `up /tmp/wc-box-scratch` booted and SSH answered in 8 seconds, and the whole command finished in
   8.7 seconds.
3. Inside, as `agent`, the project is at `/tmp/wc-box-scratch`, the same path as the host. Writing
   `guest.txt` there appeared on the host as `alanleal:alanleal` with the expected contents. Writes
   to `.widecode/x`, `.claude/x` and `.git/hooks/x` all failed with `Read-only file system`. The
   mounts were `project` on the project `(rw)` and `(ro)` over the three protected paths.
   `sudo -n true` failed with `sudo: a password is required`.
4. With the network restricted, `curl -sS -m 5 https://example.com` failed with
   `curl: (6) Could not resolve host: example.com`. `getent hosts example.com` printed nothing and
   exited 2.
5. `down` powered the guest down; the QEMU pid was gone and no `qemu-system-x86_64` process was left.

### One VM, the proxy, and the agents

Tested with two scratch git repositories, `/tmp/a` and `/tmp/b`, each with `file.txt`, `.widecode/`,
`.claude/` and `.git/hooks/`. `base.qcow2` was reused; nothing was re-provisioned.

1. `up /tmp/a /tmp/b` booted with SSH in 8 seconds and finished in 8.8 seconds. Inside, the mounts
   were `project0` on `/tmp/a` and `project1` on `/tmp/b`, both `(rw)`, with `(ro)` bind mounts of
   `.widecode`, `.claude` and `.git/hooks` under each. Writes to all six protected paths failed with
   `Read-only file system`; `guest.txt` written in `/tmp/a` appeared on the host as
   `alanleal:alanleal`. `mount` showed the two tags separately.
2. A second `up /tmp/a /tmp/b` returned in 0.05 seconds with
   `the box already runs with these projects (pid ...); nothing to do`. `up /tmp/a` alone exited 1
   with `the box is running with /tmp/a, /tmp/b; the project list changed, so run down, then up
   again (one VM for every project)`. One `qemu-system-x86_64` process existed, with both `-virtfs`
   arguments.
3. With `proxy --port 8899` on the host and `ssh --forward-proxy 8899`, `curl -sS -m 10
   -D - -o /dev/null https://api.anthropic.com` answered `HTTP/1.1 200 Connection Established` and
   then `HTTP/2 404` from Anthropic (any answer proves the path). `curl ... https://example.com`
   failed with `curl: (56) CONNECT tunnel failed, response 403`. The proxy log held
   `allowed CONNECT api.anthropic.com:443` and `refused CONNECT example.com:443`. Without the
   forward, curl failed as before with `curl: (6) Could not resolve host: api.anthropic.com`; the
   remote `HTTPS_PROXY` was set by the forward, not by the guest's network.
4. A throwaway `python3 -m http.server` on the host on a random port, reached with
   `ssh --forward 8765:<port> -- 'curl -sS http://127.0.0.1:8765/'`, returned the host file's
   contents (`hello from host`).
5. `ssh --forward-proxy 8899 -- opencode acp` answered the one-line `initialize` request with:
   ```
   {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":true},"promptCapabilities":{"embeddedContext":true,"image":true},"sessionCapabilities":{"close":{},"fork":{},"list":{},"resume":{}}},"authMethods":[{"description":"Run `opencode auth login` in the terminal","name":"Login with opencode","id":"opencode-login"}],"agentInfo":{"name":"OpenCode","version":"1.19.5"}}}
   ```
   No model call was made.
6. `claude --version` printed `2.1.316 (Claude Code)` and `claude -p --help` printed its usage, both
   over the forwarded session and with no model call.
7. `down` stopped the proxy and powered the guest down in 5.2 seconds. No QEMU process, proxy process
   or throwaway HTTP server of the test was left, and `box.lock` and `proxy.pid` were gone. `status`
   showed `not running`, the proxy `not running`, and the last project list.

### Credentials and a model call

Tested with a throwaway credentials file under `/tmp` holding fake values, never the user's file.
`base.qcow2` was reused; nothing was re-provisioned.

1. A file with mode 644 was refused before any boot with
   `has mode 644; run chmod 600 ...`, and a file in a folder with mode 755 with
   `has mode 755; run chmod 700 ...`. In a 700 folder with mode 600 it was accepted.
2. `up /tmp/wc-box-creds` installed the credentials after SSH answered. Inside,
   `/home/agent/.config/widecode-box` was mode 700 and its `env` file mode 600;
   `test -n "$CLAUDE_CODE_OAUTH_TOKEN"` in a `box.mjs ssh` session printed `set`. The opencode
   `auth.json` was mode 600 and held an `opencode-go` entry with `type` and `key` keys (reported as
   present, value not shown). `creds` printed `set` for both in the file and
   `claude set, opencode-go present` in the box.
3. With `proxy --port 8899` and `ssh --forward-proxy 8899`,
   `claude -p "say ok"` failed with `Failed to authenticate. API Error: 401 OAuth access token is
   invalid` (exit 1), and the proxy log showed only `api.anthropic.com`. `opencode run -m
   opencode-go/deepseek-v4.1-flash "say ok"` failed with `Upstream request failed: Invalid
   credential` (exit 1), after reaching `opencode.ai`, `models.opencode.ai` and
   `registry.npmjs.org`, all allowed. Neither was a network or proxy error and no host was refused.
4. After `down`, emptying `OPENCODE_API_KEY` and running `up` again removed the `opencode-go` entry
   (`opencode-absent`, Claude still `set`). A second cycle with both keys empty removed the Claude
   `env` file as well (`env-absent`) and left the box with no credentials.
5. `down` stopped the proxy and the guest; no QEMU or proxy process of the test was left.

### virtiofs, sizing, dev ports and a build in the box

`base.qcow2` was re-provisioned for this (40 GB, node 24, pnpm, clang, the scriptc wrapper), so the
tests below started from a cold image and a cold build cache.

1. `up /tmp/wc-box-scratch` used virtiofs (sandbox `none`), with `project0 on /tmp/wc-box-scratch
   type virtiofs (rw,relatime)` and `(ro,relatime)` bind mounts of `.widecode`, `.claude` and
   `.git/hooks`. `guest.txt` written in the guest appeared on the host as `1000:1000` (the user),
   and writes to the three protected paths failed with `Read-only file system`. Boot to SSH was 9
   seconds; the whole `up` took 9.5 seconds.
2. The same `/home/alanleal/Projects/widecode` share, timed in the guest (two runs, second shown):

   | probe | virtiofs | 9p |
   |---|---|---|
   | `time git status` | 0.02 s | 0.65 s |
   | `time sh -c 'find . -type f \| wc -l'` | 0.05 s | 0.27 s |

   Both found the same 2760 files. The first virtiofs run was 0.08 s and 0.10 s; the gap is larger
   on many small file operations, which is what a build does.
3. `up --memory 6144 --cpus 4 --port 3500 /home/alanleal/Projects/widecode
   /home/alanleal/Projects/light /home/alanleal/Projects/scriptc` used three virtiofs shares (the
   `light` symlink inside widecode resolved through the separately shared light path) and was up in
   9.9 seconds. A `python3 -m http.server 3500` in the guest answered `HTTP/1.0 200 OK` from
   `curl http://127.0.0.1:3500/` on the host. The throwaway server was stopped afterwards.
4. The host's `git -C /home/alanleal/Projects/widecode status --short` was `M
   box/box.mjs` before and after; the guest's build left only gitignored outputs.
   `scriptc-dev --version` in the guest printed `0.4.5` from the shared checkout.
5. `light test -- api.test.ts` is node-only by its first line (`// node-only: the
   test walks the repository ...`), so it does not compile with scriptc: cold 0.6 s, warm 1.0 s, and
   light reports `(node only)`. To exercise the box's scriptc toolchain, `keymap.test.ts` (an
   ffi test that runs under node and natively) took 65 s cold and 21 s warm; both runs passed with
   equal output, and the guest cache grew to 254 MB. Root stayed at 40 GB with 35 GB free.
6. `down` powered the guest down in 5 seconds. No `qemu-system-x86_64`, `virtiofsd` or proxy of the
   test was left, and the widecode checkout's `git status --short` matched the recorded one.

## What did not work, and why

- The first seed ISO put `user-data` and `meta-data` in the image under other names. Cloud-init
  reported `DataSourceNone` and ignored it. NoCloud requires those two exact names at the root.
- Cloud-init regenerated the SSH host keys on the new instance-id of each `up`, so
  `StrictHostKeyChecking=accept-new` refused the changed key. The seeds now set
  `ssh_deletekeys: false`, and the boot keeps the host keys generated in `base.qcow2`.
- The Debian cloud kernel (`linux-image-*-cloud-amd64`) ships no 9p modules, so the share could not
  mount and the boot waited for a marker that never came. Provisioning now installs
  `linux-image-amd64`. GRUB still picked the cloud kernel first, so the provision script purges the
  cloud kernel packages and runs `update-grub`; later boots run `6.12.113+deb13-amd64`.
- `sudo` exists in the image, but `agent` is not in sudoers and has no password, so `sudo -n` fails
  as required.
- The first `ssh --forward-proxy` set the proxy variables as a command prefix
  (`HTTPS_PROXY=... curl ...`). In a shell that applies only to the first command, so the `env`
  check saw them but a later curl in the same remote command did not. The remote command now exports
  them.
- `opencode auth login -p opencode-go` prompts for the key on a TTY (a Bun prompt), so a key piped
  to its stdin was ignored and no `auth.json` was written. The box writes the documented
  `auth.json` entry itself instead.
- A non-login SSH command got the system `PATH` only, so `claude` and `opencode` were not found even
  though provisioning reported them. `ssh` now prepends `~/.local/bin` and `~/.opencode/bin` to the
  remote `PATH`.
- The proxy needs its own pid file (`proxy.pid`) so `down` can stop a proxy started in another
  terminal; without it `down` had no way to know a proxy was running.
- `python3 -m http.server 0` printed its port only with `-u` in the capture used for the forward
  test; this is a test-harness detail, not a box issue.
- virtiofsd's default `--sandbox namespace` failed on this host with `sandbox: couldn't setup id
  mappings: ... newuidmap: No such file or directory`; `newuidmap` is in the `uidmap` package, which
  is not installed. `up` uses `namespace` when it finds `newuidmap` and `none` otherwise. Installing
  `uidmap` on the host restores the sandbox without a code change.
- A cloud-init `write_files` entry under `/home/agent/.local/bin` created the parent folders as
  root, so the agent could not install into `~/.local` (`EACCES ... mkdir
  '/home/agent/.local/share'`, and no agent was installed). The provision script now creates
  `~/.local/bin`, runs `chown -R agent:agent /home/agent/.local`, and writes the scriptc wrapper
  there itself instead of through `write_files`.
- QEMU connected to the virtiofsd socket before virtiofsd had finished exiting on the failed
  namespace sandbox, which read as `Connection refused`; `up` now waits for the socket and checks
  the daemon is still alive before it starts QEMU.
