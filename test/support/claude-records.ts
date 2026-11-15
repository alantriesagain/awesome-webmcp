// What the tests that replay Claude Code's recorded traffic read from a record (the plugin that
// reads them for the app is plugins/claude/index.ts): its fields, a message's text and
// images, and where a folder's sessions are kept under a projects folder.

/** A record or nested object, every field `unknown`. */
export interface Rec {
  type?: unknown;
  subtype?: unknown;
  status?: unknown;
  message?: unknown;
  content?: unknown;
  request?: unknown;
  tool_name?: unknown;
  name?: unknown;
  text?: unknown;
  isReplay?: unknown;
}

export const rec = (v: unknown): Rec | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null);
export const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A message's text and its count of images. */
export class Said {
  text: string;
  images: number;

  constructor(text: string, images: number) {
    this.text = text;
    this.images = images;
  }
}

/** A message's content: a string, or text and image blocks. */
export const contentText = (content: unknown): Said => {
  if (typeof content === "string") return new Said(content, 0);
  let text = "";
  let images = 0;
  if (Array.isArray(content))
    for (const b of content as unknown[]) {
      const block = rec(b);
      if (block === null) continue;
      if (str(block.type) === "text") text += (text.length > 0 ? "\n" : "") + str(block.text);
      else if (str(block.type) === "image") images++;
    }
  return new Said(text, images);
};

/** The folder Claude Code keeps `folder`'s sessions in, under `projects`: every non-alphanumeric as '-'. */
export const projectDir = (projects: string, folder: string): string => projects + "/" + folder.replace(/[^A-Za-z0-9]/g, "-");
