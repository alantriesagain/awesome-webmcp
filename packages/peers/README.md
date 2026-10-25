# @widecode/peers

The LAN git bridge: widecode shares a machine's repositories with the machines it paired with, in place and read-only, and the other side fetches. One daemon per machine serves while no session runs; the sessions drive it over a local control API. Nothing is written into a repository: the identity, the registry and the daemon's state live under the store (`~/.widecode/peers/`).

| File | Role |
|---|---|
| `identity.ts` | The machine's ed25519 keypair, made once (`identity.json`, user-readable only); the peer id is the public key's SHA-256; tokens are 32 random bytes as base64url |
| `registry.ts` | `peers.json`: the paired peers (key, the token they present, the token we present, last address) and the shared repositories (the root commit as the identity other machines match, the path, `live` or `hosted`, a branch filter, an allow list; a share's key is `r/<rootCommit>` or `h/<name>`); `peerByToken` compares in constant time |
| `pairing.ts` | The code the host shows for two minutes, the joiner's proof (an HMAC of its public key under the code), the exchange of keys and mutual tokens, `joinPeer` as the client |
| `git-http.ts` | The smart HTTP protocol as `git http-backend` serves it: `GET /r/<id>/info/refs?service=…` and `POST /r/<id>/git-upload-pack` piped through `git upload-pack --stateless-rpc`; `git-receive-pack` for hosted repositories; `Git-Protocol` passed through; gzipped bodies inflated; `transfer.hideRefs` keeps a repository to its branch filter and hides remote-tracking refs, stashes and notes; `GET /repos` lists what a peer may fetch |
| `daemon.ts` | `startDaemon`: the LAN listener (`/pair` without a token while a code is shown, `/ping`, everything else with a token, private addresses only) and the loopback control API (`/api/state`, `/api/pair/start`, `/api/pair/join`, `/api/share`, `/api/unshare`, `/api/forget`, `/api/rename`, `/api/host` (a bare repository, made under `hosted/` when no path is given, that paired peers may push into), `/api/peers/refresh` to ping every peer, `/api/peer/repos` for what one offers, `/api/peer/sync` to fetch what one offers into this machine's shared checkouts and count (one offer by `key`; a second asker waits for the sync in flight), `/api/clone` to clone an offer this machine lacks and share it, `/api/stop`); the state file `daemon.json` (pid, ports, the control token); one daemon per machine; every online peer synced every `syncMs` (two minutes; `--sync-ms 0` leaves it to the sessions' asking) and after a pairing |
| `sync.ts` | A peer's offers against this machine's live shares: each offer matched by root commit becomes a remote named after the peer in that checkout (the token under the peer's base URL in the checkout's config), is fetched (refs only), and the checkout's current branch is counted against the peer's branch of the same name (`rev-list --left-right --count`), with the commits new over there (`FRESH_MAX` newest); an offer this machine has no share of is listed with no local path; a live offer wins over a hosted one of the same repository |
| `discovery.ts` | This machine announced as `_widecode._tcp` with its id and name in the TXT record, and the network browsed for the others, through `avahi-publish-service` and `avahi-browse -rptk` on Linux, `dns-sd -R`, `dns-sd -Z` and `dscacheutil` on macOS; pure parsers over the tools' output; a paired machine seen is marked online, an unknown one is listed as nearby and can be joined by name |
| `client.ts` | `DaemonClient`: the session's side, reading the state file, asking the control API, starting the daemon detached when none answers |

## How a fetch flows

A peer's remote in a checkout is `http://<address>:<port>/r/<rootCommit>` for a live checkout, or `/h/<name>` for a hosted repository (so a checkout and a hosted mirror of the same repository can both be served), with the token in `http.<that url>.extraHeader = Authorization: Bearer …` of the local `.git/config`, never in the URL. git asks for the advertisement, the daemon answers the service header then `git upload-pack --stateless-rpc --advertise-refs <path>`, git posts its wants and haves, the daemon pipes them into `git upload-pack --stateless-rpc <path>` and the pack comes back. The served checkout's working tree and index are never touched; a fetch reads objects and refs only.

## What a session sees

The control API's `/api/state` carries each peer's last sync (`syncs`): for every repository the peer offers, this machine's checkout of it, the remote, the branch, ahead and behind, the fresh commits and the time. The Peers tab draws that; the daemon does the fetching, on its own interval while a peer is online and when a session asks, so what the tab says holds for the whole machine and stays current while no session is open.

## What is and is not sent

Local branches and tags of a shared repository, or the branches its filter names; never the index, the working tree, stashes, notes or remote-tracking refs. A request from an address outside the private ranges is refused. A peer sees only the repositories whose allow list names it, or that have none. Revoking a peer removes its token; its next request is a 401.

## Tests

`packages/peers/test/`: the registry and identity round trips, pairing (a proof that holds, a wrong code, an expired one), and the git server end to end with a real `git clone` over the loopback, with and without the token, with a branch filter, with protocol v2, with a gzipped request, and a push into a hosted bare repository; the daemon end to end (two daemons on the loopback: pairing, refresh, a peer's offers, hosting, a sync that counts a commit made on the other side and leaves the working tree alone, a clone of an offer this machine lacked). Run with `light-native test @widecode/peers`; every test prints the same under node and natively.
