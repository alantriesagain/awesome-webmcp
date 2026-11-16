// widecode --peers-daemon: the LAN git bridge's daemon instead of the interface. It shares
// nothing with the app below: no terminal, no folder, its own log.
import { BUILD } from "../build.ts";
import { peersDaemonMain } from "../peers/cli.ts";
import { Store } from "../services/store.ts";

export const main = (argv: readonly string[]): Promise<number> => peersDaemonMain(Store.defaultRoot(), argv.slice(), BUILD);
