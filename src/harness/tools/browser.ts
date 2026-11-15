// A real browser for the web tools: headless Chromium, one process per page with a fresh profile
// under the store, the page's DOM printed once its scripts ran (`--dump-dom` after a virtual time
// budget), the profile removed after. The browser is the config's, else Playwright's headless
// shell or Chromium under ~/.cache/ms-playwright (the newest), else chromium or google-chrome on
// PATH; none found means the tools fetch with curl, and Google is not searched.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Abort, Stopper } from "../loop/abort.ts";

/** A desktop Chrome's user agent: a headless one's names itself, which some sites refuse. */
export const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
/** What a page may print, at most. */
const DOM_MAX = 8 * 1024 * 1024;
const PAGE_MS = 30000;

const onPath = (name: string): string => {
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir.length === 0) continue;
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return "";
};

/** The newest of Playwright's builds of `prefix` under `cache` holding `rel`, "" for none. */
const playwright = (cache: string, prefix: string, rels: string[]): string => {
  let names: string[] = [];
  try {
    names = readdirSync(cache).filter((n) => n.startsWith(prefix + "-"));
  } catch {
    return "";
  }
  names.sort((a, b) => Number(b.slice(prefix.length + 1)) - Number(a.slice(prefix.length + 1)));
  for (const n of names)
    for (const rel of rels) {
      const path = join(cache, n, rel);
      if (existsSync(path)) return path;
    }
  return "";
};

/** The browser the web tools run: `configured` when given, else Playwright's under `home`, else one on PATH; "" for none. */
export const findBrowser = (configured: string, home: string): string => {
  if (configured.length > 0) return configured.includes("/") ? (existsSync(configured) ? configured : "") : onPath(configured);
  if (home.length > 0) {
    const cache = join(home, ".cache", "ms-playwright");
    const shell = playwright(cache, "chromium_headless_shell", [join("chrome-headless-shell-linux64", "chrome-headless-shell"), join("chrome-linux", "headless_shell")]);
    if (shell.length > 0) return shell;
    const full = playwright(cache, "chromium", [join("chrome-linux64", "chrome"), join("chrome-linux", "chrome")]);
    if (full.length > 0) return full;
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const path = onPath(name);
    if (path.length > 0) return path;
  }
  return "";
};

/** How a program ended: its exit code, its output (cut at the cap), whether it ran out of time, an error starting it. */
export class ProgramEnd {
  code = -1;
  timedOut = false;
  out = "";
  error = "";
}

/** Run `file` with `args`, its output kept up to `maxBytes`, killed past `timeoutMs` or on abort. */
export const runProgram = (file: string, args: string[], timeoutMs: number, maxBytes: number, abort: Abort): Promise<ProgramEnd> =>
  new Promise<ProgramEnd>((settle) => {
    const end = new ProgramEnd();
    let child: ChildProcess;
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      end.error = e instanceof Error ? e.message : file + " could not start";
      settle(end);
      return;
    }
    let done = false;
    let size = 0;
    const stopper = new Stopper();
    const started = Date.now();
    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!done) child.kill("SIGKILL");
      }, 2000);
    };
    const watch = setInterval(() => {
      if (!done && Date.now() - started > timeoutMs) {
        end.timedOut = true;
        kill();
      }
    }, 250);
    const finish = (): void => {
      if (done) return;
      done = true;
      clearInterval(watch);
      abort.unwatch(stopper);
      settle(end);
    };
    stopper.stopNow = () => kill();
    abort.watch(stopper);
    const decoder = new StringDecoder("utf8");
    child.stdout!.on("data", (c: Buffer) => {
      if (size >= maxBytes) return;
      size += c.length;
      end.out += decoder.write(c);
      if (size >= maxBytes) kill();
    });
    child.on("error", (e: Error) => {
      end.error = e.message;
      finish();
    });
    child.on("close", (code: number | null) => {
      end.out += decoder.end();
      end.code = code === null ? -1 : code;
      finish();
    });
  });

/** The DOM of `url` once its scripts ran, from `browser` with a fresh profile under `profileRoot`. */
export const dumpDom = async (browser: string, url: string, profileRoot: string, abort: Abort): Promise<ProgramEnd> => {
  let profile = "";
  try {
    mkdirSync(profileRoot, { recursive: true });
    profile = mkdtempSync(join(profileRoot, "p-"));
  } catch (e) {
    const failed = new ProgramEnd();
    failed.error = "no profile folder: " + (e instanceof Error ? e.message : String(e));
    return failed;
  }
  const shell = browser.includes("headless_shell") || browser.includes("headless-shell");
  const args = [
    shell ? "--headless" : "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--mute-audio",
    "--hide-scrollbars",
    "--lang=en-US",
    "--user-agent=" + USER_AGENT,
    "--user-data-dir=" + profile,
    "--virtual-time-budget=5000",
    "--dump-dom",
    url,
  ];
  const end = await runProgram(browser, args, PAGE_MS, DOM_MAX, abort);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // A profile left behind is removed with the next ones' folder.
  }
  return end;
};
