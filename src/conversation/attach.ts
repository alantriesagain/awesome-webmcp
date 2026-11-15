// Images and files attached by reference: an `@path` typed by hand, or a path a file manager
// copied (a `file://` URI, an absolute path, or one under `~`, quoted or not). A whole line that is
// one path may hold spaces (a file manager copies one file per line); a reference inside a line may
// not. An image (png, jpg, jpeg, gif or webp) is read and sent as an image block, its text becoming
// "[Image #N]"; another file stays in the text as the path, which the agent reads itself, while the
// composer shows it as "[File #N]".
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { expandHome } from "@lightstart/lib/paths.ts";
import { ImageBlock } from "./agent.ts";

/** The API's limit is 5 MB of base64; this leaves room for the encoding. */
export const IMAGE_MAX = 3750000;

const TYPES = new Map<string, string>([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);

export class Attached {
  text = "";
  images: ImageBlock[] = [];
  error = "";
}

export const mediaTypeOf = (path: string): string => {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : (TYPES.get(path.slice(dot + 1).toLowerCase()) ?? "");
};

/** The path a reference names: its `@`, surrounding quotes, a `file://` scheme and any percent-encoding taken off. */
const named = (raw: string): string => {
  let p = raw.trim();
  if (p.startsWith("@")) p = p.slice(1);
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, p.length - 1);
  if (p.startsWith("file://")) p = decodeURIComponent(p.slice("file://".length));
  return p;
};

/** Whether a reference is an image the send reads, or a file left in the text. */
export const refKind = (raw: string): "image" | "file" => (mediaTypeOf(named(raw)).length > 0 ? "image" : "file");

/** A whole line that is one reference (a copied path may hold spaces): it, or "" when the line is not. */
const wholeLine = (line: string): string => {
  const t = line.trim();
  if (t.length === 0) return "";
  let p = t.startsWith("@") ? t.slice(1) : t;
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) p = p.slice(1, p.length - 1);
  const q = p.startsWith("file://") ? p.slice("file://".length) : p;
  if (!(q.startsWith("/") || q.startsWith("~/"))) return "";
  // A second scheme inside the line means it is not one path (a URL, or a reference beside another).
  if (q.includes("://")) return "";
  return /\.[A-Za-z0-9]+$/.test(q) ? t : "";
};

/** A reference inside a line: `@path`, `file://…`, `/…` or `~…` with no spaces, ending in an extension. */
const INLINE = /(^|\s)(@[^\s"']+\.[A-Za-z0-9]+|file:\/\/[^\s"']+\.[A-Za-z0-9]+|(?:~|\/)[^\s"']*\.[A-Za-z0-9]+)/gi;

/** A quoted path anywhere (a chip expanded back to a path with spaces): its quotes and the path. */
const QUOTED = /(["'])([^"'\n]+?\.[A-Za-z0-9]+)\1/g;

/** The reference's raw text and where it lies in `text`, in order. */
interface Ref {
  start: number;
  end: number;
  raw: string;
}

const refsOf = (text: string): Ref[] => {
  const out: Ref[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const found: Ref[] = [];
    QUOTED.lastIndex = 0;
    let q = QUOTED.exec(line);
    while (q !== null) {
      found.push({ start: at + q.index, end: at + q.index + q[0].length, raw: q[2] });
      q = QUOTED.exec(line);
    }
    if (found.length === 0) {
      const whole = wholeLine(line);
      if (whole.length > 0) {
        const start = at + line.indexOf(whole);
        found.push({ start, end: start + whole.length, raw: whole });
      } else {
        INLINE.lastIndex = 0;
        let m = INLINE.exec(line);
        while (m !== null) {
          const raw = m[2] ?? "";
          const start = at + m.index + m[1].length;
          found.push({ start, end: start + raw.length, raw });
          m = INLINE.exec(line);
        }
      }
    }
    out.push(...found);
    at += line.length + 1;
  }
  return out;
};

/** Rewrite `text` with each reference as "[Image #N]" or "[File #N]", `number` giving the N (and hearing the raw reference). */
export const chipImages = (text: string, number: (raw: string) => number): string => {
  const refs = refsOf(text);
  if (refs.length === 0) return text;
  let out = "";
  let at = 0;
  for (const r of refs) {
    out += text.slice(at, r.start) + "[" + (refKind(r.raw) === "image" ? "Image" : "File") + " #" + String(number(r.raw)) + "]";
    at = r.end;
  }
  return out + text.slice(at);
};

const locate = (folder: string, path: string): string => {
  const p = expandHome(path);
  return isAbsolute(p) ? p : resolve(folder, p);
};

export const attachImages = (text: string, folder: string): Attached => {
  const out = new Attached();
  const fail = (why: string): Attached => {
    const a = new Attached();
    a.error = why;
    return a;
  };
  let rewritten = "";
  let at = 0;
  for (const r of refsOf(text)) {
    rewritten += text.slice(at, r.start);
    at = r.end;
    // Another file stays where it was: the agent reads the path itself.
    if (refKind(r.raw) !== "image") {
      rewritten += text.slice(r.start, r.end);
      continue;
    }
    const type = mediaTypeOf(named(r.raw));
    const path = locate(folder, named(r.raw));
    if (!existsSync(path) || !statSync(path).isFile()) return fail("no image at " + path);
    if (statSync(path).size > IMAGE_MAX) return fail("the image " + path + " is over " + String(Math.round(IMAGE_MAX / 1000000)) + " MB");
    out.images.push(new ImageBlock(type, readFileSync(path).toString("base64"), path));
    rewritten += "[Image #" + String(out.images.length) + "]";
  }
  out.text = rewritten + text.slice(at);
  return out;
};
