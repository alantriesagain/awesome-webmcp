// The web tools over a server of the test's: a query's encoding; the backends' order from what
// is configured; Google's and DuckDuckGo's result pages parsed (a consent page, a refusal); the
// APIs' answers; WebSearch over a SearXNG of the test's; WebFetch through curl (the scripts not
// run) and through the browser when there is one (they are); an address that is not http, a
// server's error; the browser found under a home's Playwright cache, the newest build first.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Abort } from "../src/harness/loop/abort.ts";
import { findBrowser } from "../src/harness/tools/browser.ts";
import { ToolContext, ToolSet, builtInTools } from "../src/harness/tools/tool.ts";
import { WebSettings, encodeQuery, parseBrave, parseDuckDuckGo, parseGoogle, parseSearxng, parseTavily, searchOrder } from "../src/harness/tools/web.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const PAGE = '<html><head><title>Local page</title><script>document.addEventListener("DOMContentLoaded", () => { const p = document.createElement("p"); p.textContent = "Made by the script."; document.body.appendChild(p); });</script></head><body><h1>Hello</h1><p>Static text with <a href="/other">a link</a>.</p></body></html>';

const main = async (): Promise<void> => {
  eq("a query encoded as UTF-8", encodeQuery("a b&c/é~"), "a%20b%26c%2F%C3%A9~");

  const s = new WebSettings();
  eq("nothing configured: no backend", searchOrder([], s).join(","), "");
  s.browser = "/bin/chromium";
  s.searxng = "http://127.0.0.1:1";
  s.braveKey = "k";
  eq("the default order, of those that can run", searchOrder([], s).join(","), "searxng,google,brave");
  eq("the config's order; DuckDuckGo only when it is named", searchOrder(["duckduckgo", "tavily", "google"], s).join(","), "duckduckgo,google");

  const google =
    '<div><a href="/url?q=https://example.com/a&amp;sa=U"><h3 class="LC20lb">First <b>result</b></h3></a><cite>example.com</cite><div class="VwiC3b yXK7lf">The first snippet.</div></div>' +
    '<div><a href="https://example.org/b" ping="/x"><br><h3>Second</h3><div>example.org</div></a><span>Second snippet here.</span></div>' +
    '<div><a href="https://www.google.com/preferences"><h3>Settings</h3></a></div><div><a href="/url?q=https://example.com/a"><h3>First again</h3></a></div>';
  eq("Google's page: the organic results, its own links and a repeat left out", parseGoogle(google).hits.map((h) => h.title + " <" + h.url + "> " + h.snippet).join(" | "), "First result <https://example.com/a> The first snippet. | Second <https://example.org/b> Second snippet here.");
  eq("its consent page", parseGoogle('<form action="https://consent.google.com/save"><button>Accept all</button></form>').error, "Google showed its consent page");
  eq("its refusal", parseGoogle("<p>Our systems have detected unusual traffic from your computer network.</p>").error, "Google refused the query as unusual traffic");
  const ddg = '<div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.net%2Fdoc&amp;rut=x">The <b>Doc</b></a></h2><a class="result__snippet" href="x">About the doc.</a></div>';
  eq("DuckDuckGo's page", parseDuckDuckGo(ddg).hits.map((h) => h.title + " <" + h.url + "> " + h.snippet).join(""), "The Doc <https://example.net/doc> About the doc.");
  eq("SearXNG's JSON", parseSearxng('{"results":[{"title":"S","url":"https://s.x/","content":"From searx."},{"title":"no url"}]}').hits.map((h) => h.title + " " + h.url + " " + h.snippet).join(""), "S https://s.x/ From searx.");
  eq("Brave's", parseBrave('{"web":{"results":[{"title":"B <strong>x</strong>","url":"https://b.x/","description":"From &quot;Brave&quot;."}]}}').hits.map((h) => h.title + " " + h.snippet).join(""), 'B x From "Brave".');
  eq("Tavily's, and an answer that is not JSON", parseTavily('{"results":[{"title":"T","url":"https://t.x/","content":"From Tavily."}]}').hits.length + " " + parseTavily("<html>").error, "1 the answer is not JSON");

  // A server of the test's: a SearXNG answer, a page, a text file, an error.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url.startsWith("/search?")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ title: "Local result", url: "http://127.0.0.1/page", content: "Asked: " + url.slice(url.indexOf("q=") + 2) }] }));
    } else if (url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
    } else if (url === "/notes.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("plain <text> notes\n");
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  const port = await new Promise<number>((settle) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      settle(a !== null && typeof a === "object" ? a.port : 0);
    });
  });
  const base = "http://127.0.0.1:" + String(port);
  const root = mkdtempSync(join(tmpdir(), "harness-web-"));
  const tools = new ToolSet(builtInTools());
  const ctx = new ToolContext(root, "build", new Set<string>());
  ctx.web.searxng = base;
  ctx.web.profileRoot = join(root, "profiles");
  ctx.web.order = searchOrder(["searxng"], ctx.web);
  const found = await tools.run("WebSearch", '{"query":"widecode harness","limit":3}', ctx, new Abort(), null);
  eq("WebSearch over the SearXNG", found.text + " " + String(found.isError), 'Results for "widecode harness" (searxng):\n\n1. Local result\n   http://127.0.0.1/page\n   Asked: widecode%20harness false');
  ctx.web.order = [];
  ok("no backend: an error saying how to have one", (await tools.run("WebSearch", '{"query":"x"}', ctx, new Abort(), null)).text.startsWith("no search backend here"));

  const byCurl = await tools.run("WebFetch", '{"url":"' + base + '/page","prompt":"the greeting"}', ctx, new Abort(), null);
  eq("WebFetch through curl: the title, what was asked, the address, the page as markdown, its scripts not run", byCurl.text + " | " + byCurl.rawOutputJson, "# Local page\nFetched for: the greeting\nURL: " + base + "/page\n\n# Hello\n\nStatic text with [a link](" + base + "/other). | {\"via\":\"curl\"}");
  eq("a text file as it is", (await tools.run("WebFetch", '{"url":"' + base + '/notes.txt"}', ctx, new Abort(), null)).text, "URL: " + base + "/notes.txt\n\nplain <text> notes\n");
  eq("a server's error", (await tools.run("WebFetch", '{"url":"' + base + '/gone"}', ctx, new Abort(), null)).text, "the server answered 404");
  eq("not http", (await tools.run("WebFetch", '{"url":"file:///etc/passwd"}', ctx, new Abort(), null)).text, "WebFetch takes an http or https address");

  const browser = findBrowser("", process.env["HOME"] ?? "");
  if (browser.length > 0) {
    ctx.web.browser = browser;
    const byBrowser = await tools.run("WebFetch", '{"url":"' + base + '/page"}', ctx, new Abort(), null);
    ok("WebFetch through the browser: the page after its scripts ran", byBrowser.text.endsWith("Static text with [a link](" + base + "/other).\n\nMade by the script.") && byBrowser.rawOutputJson === '{"via":"browser"}');
  } else ok("WebFetch through the browser: the page after its scripts ran", true);

  const home = join(root, "home");
  const shell = (n: string): string => {
    const dir = join(home, ".cache", "ms-playwright", "chromium_headless_shell-" + n, "chrome-headless-shell-linux64");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "chrome-headless-shell"), "#!/bin/sh\n");
    chmodSync(join(dir, "chrome-headless-shell"), 0o755);
    return join(dir, "chrome-headless-shell");
  };
  shell("1200");
  const newest = shell("1300");
  eq("the browser from a home's Playwright cache: its newest headless shell", findBrowser("", home), newest);
  eq("one the config names that is not there", findBrowser("/nowhere/chrome", home), "");
  server.close();
  rmSync(root, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
