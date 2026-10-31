# widecode's VM box (spike)

V1 in `PLAN-security.md`: a Debian 13 VM that an agent can run in, built and driven by node scripts
with no dependencies. It follows bootstrapp's test VM (`packages/vps/testvm/vm.mjs`): QEMU runs as
the user, the Debian cloud image is a read-only backing file, each box is a fresh qcow2 overlay,
cloud-init comes in on a genisoimage seed ISO, networking is user-mode with one hostfwd, and the
state is a pid file plus a console log.

There is one VM. It shares every project `up` lists, each at its own host path, so every agent in
every project uses the same guest. A lock file and the QEMU pid file keep a second VM from starting.

State lives in `~/.cache/widecode/box/` (override with `WIDECODE_BOX_DIR`). The cached image at
`~/.cache/bootstrapp/vps-test/debian-13-genericcloud-amd64.qcow2` is used as the backing file when it
exists; otherwise the image is downloaded into the box's own state directory. The box has its own
SSH key under `~/.cache/widecode/box/id_ed25519` and its own `known_hosts`.

## Commands

```
node apps/widecode/box/box.mjs provision
node apps/widecode/box/box.mjs up <folder> [<folder>...]
node apps/widecode/box/box.mjs ssh [--forward-proxy <port>] [--forward <remotePort>:<hostPort>]... [--] [cmd...]
node apps/widecode/box/box.mjs proxy [--port N] [--allow domain,...]
node apps/widecode/box/box.mjs down
node apps/widecode/box/box.mjs status
node apps/widecode/box/box.mjs reset
```

`provision` builds `base.qcow2`, an overlay on the cached Debian image resized to 20 GB, and boots it
once with the network open. Cloud-init creates the `agent` user (shell, the box's public key, no
sudo), installs git, ripgrep, curl, ca-certificates and `linux-image-amd64`, and runs Claude Code's
and opencode's own installers as `agent`. It then reports the paths and versions over SSH and powers
the guest down through the QEMU monitor, leaving `base.qcow2` provisioned.

`up` creates a fresh `box.qcow2` overlay on `base.qcow2` and boots it with
`-netdev user,id=n0,restrict=on,hostfwd=tcp:127.0.0.1:2223-:22`, 4096 MB, 4 CPUs and KVM. Each folder
is shared by 9p with its own tag (`project0`, `project1`, ...) at its own absolute host path, using
`security_model=none`. `security_model=none` lets QEMU do the guest's file operations as the host
user, so files the guest creates keep the host user's ownership and need no xattr mapping. A per-boot
cloud-init seed, rather than a unit baked into the image, mounts each share and bind-mounts
`.widecode/`, `.claude/` and `.git/hooks` read-only over it when they exist, because the project paths
change per boot. `up` waits for SSH and for the `/run/widecode-box-ready` marker the seed writes, and
saves the project list in `box.json`. A second `up` with the same list returns at once; with a
different list it refuses and says to run `down`, then `up`.

`proxy` is a host-side HTTP proxy on `127.0.0.1` (default port 8888, override with `--port` or
`WIDECODE_BOX_PROXY_PORT`). It handles plain HTTP and `CONNECT`, allows a host that equals an entry
in `--allow` (comma-separated, default: `api.anthropic.com`, `claude.ai`, `platform.claude.com`,
`claude.com`, `statsig.anthropic.com`, `opencode.ai`, `*.opencode.ai`, `registry.npmjs.org`,
`github.com`, `*.github.com`, `*.githubusercontent.com`) or is a subdomain of a `*.domain` entry, and
answers 403 to everything else. It logs every allowed and refused request to `proxy.log` in the state
directory, writes its pid to `proxy.pid`, and runs until `down` or a signal stops it.

`ssh` runs as `agent` with the box key, `BatchMode=yes` and the box's own `known_hosts`. It puts
`~/.local/bin` and `~/.opencode/bin` first on the remote `PATH`, so `claude` and `opencode` resolve
without a login shell. `--forward-proxy <port>` adds `-R <port>:127.0.0.1:<port>` and exports
`HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY=localhost,127.0.0.1` in the remote command; `--forward
<remotePort>:<hostPort>` adds `-R <remotePort>:127.0.0.1:<hostPort>` and may be repeated. Forwards use
`ExitOnForwardFailure=yes`. `down` stops the proxy, asks for an ACPI powerdown through the QEMU
monitor and terminates the process after 45 seconds if the guest does not leave. `reset` drops
`box.qcow2`; `base.qcow2` is kept.

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
- A non-login SSH command got the system `PATH` only, so `claude` and `opencode` were not found even
  though provisioning reported them. `ssh` now prepends `~/.local/bin` and `~/.opencode/bin` to the
  remote `PATH`.
- The proxy needs its own pid file (`proxy.pid`) so `down` can stop a proxy started in another
  terminal; without it `down` had no way to know a proxy was running.
- `python3 -m http.server 0` printed its port only with `-u` in the capture used for the forward
  test; this is a test-harness detail, not a box issue.
