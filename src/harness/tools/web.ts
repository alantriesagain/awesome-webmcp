// WebFetch and WebSearch. A page is fetched through the headless browser (its scripts run, the
// DOM printed) and turned into markdown, else through curl when there is no browser; a search
// tries its backends in order until one gives results: SearXNG when the config names an instance,
// Google through the browser (its results parsed from the page; a consent or bot page gives none),
// Brave's and Tavily's APIs when there is a key, DuckDuckGo's HTML page only when the config's
// order lists it.
import { listOf, recordOf, str } from "@light/lib/json.ts";
import { Abort, Stopper } from "../loop/abort.ts";
import { HttpRequest, HttpStream } from "../http/stream.ts";
import { USER_AGENT, dumpDom, runProgram } from "./browser.ts";
import { decodeEntities, htmlToMarkdown } from "./html.ts";
import { ToolContext, ToolOutcome } from "./tool.ts";

/** What a fetch gives the model, at most. */
const PAGE_MAX = 50000;
const SEARCH_MS = 20000;
export const DEFAULT_ORDER = ["searxng", "google", "brave", "tavily"];

/** What the web tools have: the browser, where its profiles go, how HTTP is done, the search backends in order and their settings. */
export class WebSettings {
  browser = "";
  profileRoot = "";
  httpKind = "node";
  order: string[] = [];
  searxng = "";
  braveKey = "";
  tavilyKey = "";
}

/** The backends to try: `wanted` (the config's order, else the default) of those that can run. */
export const searchOrder = (wanted: string[], s: WebSettings): string[] => {
  const order = wanted.length > 0 ? wanted : DEFAULT_ORDER;
  return order.filter((b) => (b === "searxng" && s.searxng.length > 0) || (b === "google" && s.browser.length > 0) || (b === "brave" && s.braveKey.length > 0) || (b === "tavily" && s.tavilyKey.length > 0) || (b === "duckduckgo" && wanted.includes("duckduckgo")));
};

/** `s` percent-encoded for a query string, as UTF-8. */
export const encodeQuery = (s: string): string => {
  const out: string[] = [];
  const hex = (b: number): string => "%" + (b < 16 ? "0" : "") + b.toString(16).toUpperCase();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/[A-Za-z0-9\-_.~]/.test(ch)) {
      out.push(ch);
      continue;
    }
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(hex(c));
    else if (c < 0x800) out.push(hex(0xc0 | (c >> 6)), hex(0x80 | (c & 63)));
    else if (c < 0x10000) out.push(hex(0xe0 | (c >> 12)), hex(0x80 | ((c >> 6) & 63)), hex(0x80 | (c & 63)));
    else out.push(hex(0xf0 | (c >> 18)), hex(0x80 | ((c >> 12) & 63)), hex(0x80 | ((c >> 6) & 63)), hex(0x80 | (c & 63)));
  }
  return out.join("");
};

/** A whole answer over HTTP. */
export class Fetched {
  status = 0;
  body = "";
  error = "";
}

export const httpText = async (method: string, url: string, headers: string[][], body: string, httpKind: string, abort: Abort): Promise<Fetched> => {
  const got = new Fetched();
  const http = new HttpStream(httpKind);
  const stopper = new Stopper();
  stopper.stopNow = () => http.abort();
  abort.watch(stopper);
  http.onStatus = (n: number) => {
    got.status = n;
  };
  http.onChunk = (text: string) => {
    if (got.body.length < 4 * 1024 * 1024) got.body += text;
  };
  const r = new HttpRequest(url);
  r.method = method;
  r.headers = headers;
  r.body = body;
  r.idleMs = SEARCH_MS;
  r.totalMs = SEARCH_MS;
  const end = await http.start(r);
  abort.unwatch(stopper);
  got.error = end.error;
  return got;
};

export class SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;

  constructor(title: string, url: string, snippet: string) {
    this.title = title;
    this.url = url;
    this.snippet = snippet;
  }
}

export class SearchResult {
  hits: SearchHit[] = [];
  error = "";
}

const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

const hrefOf = (tag: string): string => {
  const m = /\shref\s*=\s*"([^"]*)"/i.exec(tag);
  return m !== null ? decodeEntities(m[1]) : "";
};

/** A query parameter's value in `url`, decoded ("" for none). */
const param = (url: string, name: string): string => {
  const m = new RegExp("[?&]" + name + "=([^&#]*)").exec(url);
  if (m === null) return "";
  try {
    return decodeURIComponent(m[1].replace(/\+/g, " "));
  } catch {
    return "";
  }
};

const failedWith = (why: string): SearchResult => {
  const r = new SearchResult();
  r.error = why;
  return r;
};

/** Google's results page: each organic result a link around an `<h3>`, its snippet in the block after it. */
export const parseGoogle = (html: string): SearchResult => {
  if (/consent\.google\.com|action="https:\/\/consent\./i.test(html) && !/<h3/i.test(html)) return failedWith("Google showed its consent page");
  if (/\/sorry\/index|unusual traffic/i.test(html)) return failedWith("Google refused the query as unusual traffic");
  const r = new SearchResult();
  const heads = /<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/gi;
  const starts: number[] = [];
  const titles: string[] = [];
  const ends: number[] = [];
  for (let m = heads.exec(html); m !== null; m = heads.exec(html)) {
    starts.push(m.index);
    titles.push(stripTags(m[1]));
    ends.push(m.index + m[0].length);
  }
  for (let i = 0; i < starts.length; i++) {
    const before = html.slice(Math.max(0, starts[i] - 3000), starts[i]);
    const at = before.lastIndexOf("<a ");
    if (at < 0 || before.indexOf("</a>", at) >= 0) continue;
    const tag = before.slice(at, before.indexOf(">", at) + 1);
    let url = hrefOf(tag);
    if (url.startsWith("/url?")) url = param(url, "q").length > 0 ? param(url, "q") : param(url, "url");
    if (!/^https?:\/\//.test(url) || /^https?:\/\/([a-z]+\.)?google\.[a-z.]+\//.test(url) || titles[i].length === 0 || r.hits.some((h) => h.url === url)) continue;
    const next = i + 1 < starts.length ? starts[i + 1] : Math.min(html.length, ends[i] + 6000);
    const region = html.slice(ends[i], Math.min(next, ends[i] + 6000));
    const marked = /<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(region);
    let snippet = marked !== null ? stripTags(marked[1]) : stripTags(region.slice(region.indexOf("</a>") + 4));
    if (snippet.length > 300) snippet = snippet.slice(0, 300) + "…";
    r.hits.push(new SearchHit(titles[i], url, snippet));
  }
  if (r.hits.length === 0) r.error = "no results on Google's page";
  return r;
};

/** DuckDuckGo's HTML page: `result__a` links (to its redirect, the address in `uddg`) and `result__snippet`. */
export const parseDuckDuckGo = (html: string): SearchResult => {
  const r = new SearchResult();
  const links = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  for (let m = links.exec(html); m !== null; m = links.exec(html)) {
    let url = hrefOf(m[0].slice(0, m[0].indexOf(">") + 1));
    if (url.includes("uddg=")) url = param(url, "uddg");
    if (url.startsWith("//")) url = "https:" + url;
    const rest = html.slice(m.index + m[0].length, m.index + m[0].length + 4000);
    const s = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/i.exec(rest);
    if (/^https?:\/\//.test(url)) r.hits.push(new SearchHit(stripTags(m[1]), url, s !== null ? stripTags(s[1]) : ""));
  }
  if (r.hits.length === 0) r.error = "no results on DuckDuckGo's page";
  return r;
};

/** The results of an API's JSON answer: a list under `path` of records with a title, an address and a text. */
const parseJsonHits = (text: string, path: string[], snippetField: string): SearchResult => {
  let v: unknown = null;
  try {
    v = JSON.parse(text);
  } catch {
    return failedWith("the answer is not JSON");
  }
  for (const key of path) {
    const rec = recordOf(v);
    v = rec !== null ? rec[key] : null;
  }
  const r = new SearchResult();
  for (const x of listOf(v)) {
    const h = recordOf(x);
    if (h === null || str(h["url"]).length === 0) continue;
    r.hits.push(new SearchHit(stripTags(str(h["title"])), str(h["url"]), stripTags(str(h[snippetField]))));
  }
  if (r.hits.length === 0) r.error = "no results";
  return r;
};

export const parseSearxng = (text: string): SearchResult => parseJsonHits(text, ["results"], "content");
export const parseBrave = (text: string): SearchResult => parseJsonHits(text, ["web", "results"], "description");
export const parseTavily = (text: string): SearchResult => parseJsonHits(text, ["results"], "content");

const answered = (got: Fetched, name: string): string => (got.error.length > 0 ? got.error : got.status !== 200 ? name + " answered " + String(got.status) : "");

/** One backend's results for `query`. */
const searchWith = async (backend: string, query: string, limit: number, s: WebSettings, abort: Abort): Promise<SearchResult> => {
  const q = encodeQuery(query);
  if (backend === "google") {
    const d = await dumpDom(s.browser, "https://www.google.com/search?hl=en&num=" + String(Math.min(20, limit + 2)) + "&q=" + q, s.profileRoot, abort);
    if (d.out.trim().length === 0) return failedWith(d.error.length > 0 ? d.error : d.timedOut ? "the browser ran out of time" : "the browser printed nothing");
    return parseGoogle(d.out);
  }
  if (backend === "searxng") {
    const got = await httpText("GET", s.searxng.replace(/\/+$/, "") + "/search?format=json&q=" + q, [["accept", "application/json"]], "", s.httpKind, abort);
    const why = answered(got, "SearXNG");
    return why.length > 0 ? failedWith(why) : parseSearxng(got.body);
  }
  if (backend === "brave") {
    const got = await httpText("GET", "https://api.search.brave.com/res/v1/web/search?count=" + String(Math.min(20, limit)) + "&q=" + q, [["accept", "application/json"], ["x-subscription-token", s.braveKey]], "", s.httpKind, abort);
    const why = answered(got, "Brave");
    return why.length > 0 ? failedWith(why) : parseBrave(got.body);
  }
  if (backend === "tavily") {
    const body = '{"query":' + JSON.stringify(query) + ',"max_results":' + String(Math.min(20, limit)) + "}";
    const got = await httpText("POST", "https://api.tavily.com/search", [["content-type", "application/json"], ["authorization", "Bearer " + s.tavilyKey]], body, s.httpKind, abort);
    const why = answered(got, "Tavily");
    return why.length > 0 ? failedWith(why) : parseTavily(got.body);
  }
  if (backend === "duckduckgo") {
    const got = await httpText("GET", "https://html.duckduckgo.com/html/?q=" + q, [["user-agent", USER_AGENT]], "", s.httpKind, abort);
    const why = answered(got, "DuckDuckGo");
    return why.length > 0 ? failedWith(why) : parseDuckDuckGo(got.body);
  }
  return failedWith("no backend " + backend);
};

/** Hits as the model reads them: numbered, each with its address and snippet. */
export const hitsText = (hits: SearchHit[]): string => hits.map((h, i) => String(i + 1) + ". " + h.title + "\n   " + h.url + (h.snippet.length > 0 ? "\n   " + h.snippet : "")).join("\n");

export const webSearchTool = async (input: Record<string, unknown>, ctx: ToolContext, abort: Abort): Promise<ToolOutcome> => {
  const query = str(input["query"]).trim();
  if (query.length === 0) return ToolOutcome.failed("WebSearch needs a query");
  const n = typeof input["limit"] === "number" ? (input["limit"] as number) : 8;
  const limit = Math.max(1, Math.min(20, Math.floor(n)));
  const s = ctx.web;
  if (s.order.length === 0) return ToolOutcome.failed("no search backend here: there is no browser for Google, and the config names no SearXNG instance (harness.search.searxng) and no key for Brave or Tavily (widecode --harness-auth brave)");
  const why: string[] = [];
  for (const backend of s.order) {
    if (abort.aborted) return ToolOutcome.failed("interrupted");
    const got = await searchWith(backend, query, limit, s, abort);
    if (got.hits.length > 0) {
      const o = new ToolOutcome();
      o.text = "Results for " + JSON.stringify(query) + " (" + backend + "):\n\n" + hitsText(got.hits.slice(0, limit));
      return o;
    }
    why.push(backend + ": " + got.error);
  }
  return ToolOutcome.failed("no results for " + JSON.stringify(query) + ": " + why.join("; ") + (s.order.every((b) => b === "google" || b === "duckduckgo") ? ". A SearXNG instance (harness.search.searxng in config.json) or a Brave or Tavily key (widecode --harness-auth brave) searches without being refused." : ""));
};

/** The page's text when the browser showed a document that is not HTML (text, JSON) in its viewer: a body of one `<pre>`. */
const viewerText = (html: string): string | null => {
  const m = /<body[^>]*>\s*<pre[^>]*>([\s\S]*?)<\/pre>\s*(<div[^>]*json-formatter[\s\S]*?)?<\/body>/i.exec(html);
  return m !== null ? decodeEntities(m[1]) : null;
};

export const webFetchTool = async (input: Record<string, unknown>, ctx: ToolContext, abort: Abort): Promise<ToolOutcome> => {
  const url = str(input["url"]).trim();
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return ToolOutcome.failed("WebFetch takes an http or https address");
  const s = ctx.web;
  let html = "";
  let text: string | null = null;
  let how = "";
  if (s.browser.length > 0) {
    const d = await dumpDom(s.browser, url, s.profileRoot, abort);
    if (abort.aborted) return ToolOutcome.failed("interrupted");
    if (d.out.trim().length > 0) {
      html = d.out;
      text = viewerText(html);
      how = "browser";
    }
  }
  if (how.length === 0) {
    const marker = "\n--widecode--";
    const c = await runProgram("curl", ["-sSL", "--compressed", "--max-time", "30", "-A", USER_AGENT, "-w", marker + "%{http_code} %{content_type}", url], 35000, 8 * 1024 * 1024, abort);
    if (abort.aborted) return ToolOutcome.failed("interrupted");
    const at = c.out.lastIndexOf(marker);
    if (c.error.length > 0 || at < 0) return ToolOutcome.failed("the page could not be fetched" + (c.error.length > 0 ? ": " + c.error : c.timedOut ? ": it took too long" : ""));
    const tail = c.out.slice(at + marker.length).trim();
    const status = Number(tail.split(" ")[0]);
    const type = tail.slice(tail.indexOf(" ") + 1).toLowerCase();
    const body = c.out.slice(0, at);
    if (!(status >= 200 && status < 400)) return ToolOutcome.failed("the server answered " + String(status));
    if (type.includes("html") || (type.length === 0 && /<html/i.test(body.slice(0, 2000)))) html = body;
    else text = body;
    how = "curl";
  }
  const asked = str(input["prompt"]).trim();
  const head = (asked.length > 0 ? "Fetched for: " + asked + "\n" : "") + "URL: " + url + "\n";
  let content = "";
  if (text !== null) content = head + "\n" + text;
  else {
    const page = htmlToMarkdown(html, url);
    content = (page.title.length > 0 ? "# " + page.title + "\n" : "") + head + "\n" + page.markdown;
  }
  const o = new ToolOutcome();
  o.text = content.length > PAGE_MAX ? content.slice(0, PAGE_MAX) + "\n\n[… cut at " + String(PAGE_MAX) + " characters]" : content;
  o.rawOutputJson = '{"via":' + JSON.stringify(how) + "}";
  return o;
};
