// The plugin API's `fs` calls, answered for the runtime (runtime.ts dispatches by namespace): files
// read, never written (an agent's transcripts and session lists, a plan it wrote), answered at
// once. Plugins already run any command (`process`), so reading adds no reach they lacked.
import { PreludePart } from "@lightstart/plugins/prelude.ts";
import { closeSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAt, readWindow } from "@lightstart/workspace/window.ts";
import type { JsRuntime } from "../runtime/runtime.ts";
import { HostAnswer } from "@lightstart/plugins/engine.ts";
import { answer, answerText, json, listText, num, objectText, str, strs } from "./values.ts";

/** The most of a file `text` reads. */
const TEXT_MAX = 8 * 1024 * 1024;

/** The most a window answers. Its lines are a JSON array, and a string past 4 MiB makes scriptc's
 * runtime grow a run whose move fails when the run spans two mappings, leaving the copy's
 * destination unmapped (SIGSEGV). 1.5 MiB leaves room for escaping that roughly doubles it. */
const WINDOW_BYTES_MAX = 1536 * 1024;

/** Plugin call `name` with its arguments `a`, answered; null for a call of another namespace. */
export const answerFs = (_rt: JsRuntime, name: string, a: unknown[]): HostAnswer | null => {
  switch (name) {
    case "fs.home":
      return answer(homedir());
    case "fs.env":
      return answer(process.env[str(a[0])] ?? "");
    case "fs.executable":
      return answer(process.execPath);
    case "fs.list": {
      const dir = str(a[0]);
      const out: string[] = [];
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        return answerText("[]");
      }
      names.sort();
      for (const n of names)
        try {
          const st = statSync(join(dir, n));
          out.push(objectText(["name", "file", "size", "mtimeMs"], [json(n), json(st.isFile()), String(st.size), String(Math.floor(st.mtimeMs))]));
        } catch {
          continue;
        }
      return answerText(listText(out));
    }
    case "fs.stat":
      try {
        const st = statSync(str(a[0]));
        return answerText(objectText(["size", "mtimeMs"], [String(st.size), String(Math.floor(st.mtimeMs))]));
      } catch {
        return answer(null);
      }
    case "fs.read": {
      const start = Math.max(0, num(a[1]));
      const length = Math.max(0, num(a[2]));
      try {
        const fd = openSync(str(a[0]), "r");
        try {
          return answer(readAt(fd, start, length).toString("utf8"));
        } finally {
          closeSync(fd);
        }
      } catch {
        return answer("");
      }
    }
    case "fs.text":
      try {
        const path = str(a[0]);
        if (statSync(path).size > TEXT_MAX) return answer(null);
        return answer(readFileSync(path, "utf8"));
      } catch {
        return answer(null);
      }
    case "fs.window": {
      const w = readWindow(str(a[0]), num(a[1]), Math.min(Math.max(1, num(a[2])), WINDOW_BYTES_MAX), strs(a[3]));
      return answerText(objectText(["lines", "start", "end", "size"], [json(w.lines), String(w.start), String(w.end), String(w.size)]));
    }
  }
  return null;
};

/** The `fs` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_FS = new PreludePart("fs", `        home: () => call("fs.home"),
        env: (name) => call("fs.env", String(name)),
        executable: () => call("fs.executable"),
        list: (dir) => call("fs.list", String(dir)),
        stat: (path) => call("fs.stat", String(path)),
        read: (path, start, length) => call("fs.read", String(path), Number(start ?? 0), Number(length ?? 0)),
        text: (path) => call("fs.text", String(path)),
        window: (path, before, maxBytes, skip) => call("fs.window", String(path), Number(before ?? -1), Number(maxBytes ?? 4194304), Array.from(skip ?? [], String)),
`);
