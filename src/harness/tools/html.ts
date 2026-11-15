// A page's HTML as markdown for the model: the title, then the main content (the page's `<main>`,
// else its one `<article>`, else its body without navigation, headers, footers and asides), with
// headings, paragraphs, lists, links resolved against the page's address, code and preformatted
// text, tables as rows of cells; scripts, styles, forms' controls and images dropped. A tokenizer
// over tags and text, no DOM: what the browser printed is already well formed.

const DROPPED = ["script", "style", "noscript", "template", "svg", "iframe", "canvas", "select", "textarea", "button", "object", "embed", "math"];
const NOISE = ["nav", "header", "footer", "aside", "form"];
const BLOCK = ["p", "div", "section", "article", "main", "header", "footer", "figure", "figcaption", "blockquote", "dl", "dt", "dd", "table", "address", "details", "summary", "center"];

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©", reg: "®", trade: "™",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·", laquo: "«", raquo: "»", times: "×", deg: "°", euro: "€", pound: "£",
};

/** A code point as text. */
const charOf = (n: number): string => {
  if (!(n > 0) || n > 0x10ffff) return "";
  if (n < 0x10000) return String.fromCharCode(n);
  const m = n - 0x10000;
  return String.fromCharCode(0xd800 + (m >> 10), 0xdc00 + (m & 0x3ff));
};

/** `s` with its character references decoded. */
export const decodeEntities = (s: string): string => {
  if (!s.includes("&")) return s;
  const refs = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;
  const out: string[] = [];
  let from = 0;
  for (let m = refs.exec(s); m !== null; m = refs.exec(s)) {
    out.push(s.slice(from, m.index));
    const ref = m[1];
    if (ref.startsWith("#x") || ref.startsWith("#X")) out.push(charOf(parseInt(ref.slice(2), 16)));
    else if (ref.startsWith("#")) out.push(charOf(parseInt(ref.slice(1), 10)));
    else {
      const named = NAMED[ref];
      out.push(named !== undefined ? named : m[0]);
    }
    from = m.index + m[0].length;
  }
  out.push(s.slice(from));
  return out.join("");
};

/** `href` against the page at `base`: an absolute address, or "" for one that leads nowhere to read (a fragment, a script). */
export const resolveUrl = (base: string, href: string): string => {
  const h = href.trim();
  if (h.length === 0 || h.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(h)) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h)) return h;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)/.exec(base);
  if (m === null) return h;
  if (h.startsWith("//")) return m[1] + h;
  if (h.startsWith("/")) return m[1] + "//" + m[2] + h;
  if (h.startsWith("?")) return m[1] + "//" + m[2] + m[3] + h;
  // The page's folder, then the address's segments, `..` going up one.
  const parts = m[3].slice(0, m[3].lastIndexOf("/") + 1).split("/").filter((p) => p.length > 0);
  for (const p of h.split("/")) {
    if (p === "..") parts.pop();
    else if (p !== ".") parts.push(p);
  }
  return m[1] + "//" + m[2] + "/" + parts.join("/");
};

/** An attribute's value in a tag's text ("" for none). */
const attr = (tag: string, name: string): string => {
  const m = new RegExp("\\s" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i").exec(tag);
  if (m === null) return "";
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
};

/** `html` without the elements named, their content included (outermost first, so nesting of one name is not a concern for the ones dropped). */
const without = (html: string, names: string[]): string => {
  let out = html;
  for (const n of names) out = out.replace(new RegExp("<" + n + "\\b[^>]*>[\\s\\S]*?</" + n + "\\s*>", "gi"), " ").replace(new RegExp("<" + n + "\\b[^>]*/>", "gi"), " ");
  return out;
};

/** The first element named `name`'s inner HTML, the elements of that name inside it counted ("" for none). */
const inner = (html: string, name: string): string => {
  const open = new RegExp("<" + name + "\\b[^>]*>", "i").exec(html);
  if (open === null) return "";
  const tags = new RegExp("<(/?)" + name + "\\b[^>]*>", "gi");
  tags.lastIndex = open.index + open[0].length;
  let depth = 1;
  for (let m = tags.exec(html); m !== null; m = tags.exec(html)) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(open.index + open[0].length, m.index);
  }
  return html.slice(open.index + open[0].length);
};

const count = (html: string, name: string): number => (html.match(new RegExp("<" + name + "\\b", "gi")) ?? []).length;

/** A page's title and its content as markdown. */
export class PageText {
  title = "";
  markdown = "";
}

/** `html` (the page at `base`) as markdown. */
export const htmlToMarkdown = (html: string, base: string): PageText => {
  const page = new PageText();
  const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (t !== null) page.title = decodeEntities(t[1].replace(/\s+/g, " ").trim());
  let doc = without(html.replace(/<!--[\s\S]*?-->/g, " "), DROPPED);
  const main = inner(doc, "main");
  const body = inner(doc, "body");
  if (main.replace(/<[^>]*>/g, "").trim().length > 200) doc = main;
  else if (count(doc, "article") === 1 && inner(doc, "article").replace(/<[^>]*>/g, "").trim().length > 200) doc = inner(doc, "article");
  else doc = without(body.length > 0 ? body : doc, NOISE);
  page.markdown = markdownOf(doc, base);
  return page;
};

/** The walk: tags and text into markdown. */
const markdownOf = (html: string, base: string): string => {
  const out: string[] = [];
  /** The lists open: "ul", or "ol" with its next number. */
  const lists: string[] = [];
  const numbers: number[] = [];
  /** The links open: where their text starts in `out`, and where they lead. */
  const linkAt: number[] = [];
  const linkTo: string[] = [];
  let pre = 0;
  const brk = (n: number): void => {
    out.push(n > 1 ? "\n\n" : "\n");
  };
  const tokens = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)|</g;
  for (let m = tokens.exec(html); m !== null; m = tokens.exec(html)) {
    if (m[4] !== undefined) {
      const text = decodeEntities(m[4]);
      out.push(pre > 0 ? text : text.replace(/\s+/g, " "));
      continue;
    }
    if (m[2] === undefined) {
      out.push("<");
      continue;
    }
    const close = m[1] === "/";
    const name = m[2].toLowerCase();
    const tag = m[0];
    if (/^h[1-6]$/.test(name)) {
      brk(2);
      if (!close) out.push("#".repeat(Number(name.slice(1))) + " ");
    } else if (name === "br") out.push("\n");
    else if (name === "hr") {
      brk(2);
      out.push("---");
      brk(2);
    } else if (name === "ul" || name === "ol") {
      // A list inside another goes on from its item's line; the outermost one is a block.
      if (close) {
        lists.pop();
        numbers.pop();
      } else {
        if (lists.length === 0) brk(2);
        lists.push(name);
        numbers.push(Number(attr(tag, "start")) > 0 ? Number(attr(tag, "start")) : 1);
      }
      if (close && lists.length === 0) brk(2);
    } else if (name === "li") {
      if (close) continue;
      const depth = Math.max(0, lists.length - 1);
      const top = lists.length - 1;
      let mark = "- ";
      if (top >= 0 && lists[top] === "ol") {
        mark = String(numbers[top]) + ". ";
        numbers[top]++;
      }
      out.push("\n" + "  ".repeat(depth) + mark);
    } else if (name === "pre") {
      if (!close) {
        brk(2);
        out.push("```\n");
        pre++;
      } else if (pre > 0) {
        // The fence closes on the line after the code's last one.
        while (out.length > 0 && /\s$/.test(out[out.length - 1])) out[out.length - 1] = out[out.length - 1].replace(/\s+$/, "");
        out.push("\n```");
        brk(2);
        pre--;
      }
    } else if (name === "code" && pre === 0) out.push("`");
    else if (name === "a") {
      if (!close) {
        linkAt.push(out.length);
        linkTo.push(resolveUrl(base, attr(tag, "href")));
      } else if (linkAt.length > 0) {
        const at = linkAt.pop() ?? 0;
        const to = linkTo.pop() ?? "";
        const text = out.splice(at, out.length - at).join("").replace(/\s+/g, " ").trim();
        out.push(to.length > 0 && text.length > 0 ? "[" + text + "](" + to + ")" : text);
      }
    } else if (name === "td" || name === "th") {
      if (close) out.push(" | ");
    } else if (name === "tr") {
      if (close) out.push("\n");
    } else if (name === "img") {
      const alt = attr(tag, "alt").trim();
      if (alt.length > 0) out.push("[image: " + alt + "]");
    } else if (BLOCK.includes(name) || name === "li") brk(name === "div" ? 1 : 2);
  }
  // Lines without their trailing spaces, runs of spaces made one outside code, at most one blank line.
  let fenced = false;
  const lines: string[] = [];
  for (const raw of out.join("").split("\n")) {
    if (raw.startsWith("```")) fenced = !fenced;
    const l = raw.replace(/[ \t]+$/, "");
    lines.push(fenced || raw.startsWith("```") ? l : l.replace(/(\S) {2,}/g, "$1 "));
  }
  return lines.join("\n").replace(/\n[ \t]+\n/g, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
};
