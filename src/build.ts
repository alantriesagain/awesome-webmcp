// The build, as the log, the status bar, --version and the daemons say it. The generated
// build-info.ts holds the version and the time; this is the one line the app builds from them.
import { BUILD_TIME, BUILD_VERSION } from "./runtime/build-info.ts";

export const BUILD = "lightcode " + BUILD_VERSION + " built " + BUILD_TIME;
