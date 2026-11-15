// The JSONL store's files through `node:fs`: the io for a data directory, made when the first write
// lands (an untouched folder keeps no directory); a whole write lands beside the file and is renamed
// over it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonlIO } from "@lightstart/light/model";
import { writeAtomic } from "@light/lib/fs.ts";

export const fileIO = (): JsonlIO => ({
  read: (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  append: (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, text);
  },
  write: (path: string, text: string) => writeAtomic(path, text),
});
