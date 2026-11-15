// A page's HTML as markdown: the title; the main content chosen (a page's <main>, its one
// <article>, else its body without navigation, headers, footers and asides); headings, paragraphs,
// nested and numbered lists, links resolved against the page, code and preformatted text kept,
// tables as rows, an image's alt text; scripts, styles and forms dropped; character references
// decoded; addresses resolved.
import { decodeEntities, htmlToMarkdown, resolveUrl } from "../src/harness/tools/html.ts";
import { done, eq } from "@lightstart/test/assert.ts";

eq("references decoded: named, decimal, hex, one beyond the basic plane, an unknown one kept", decodeEntities("a &amp; b &lt;c&gt; &#233; &#x2014; &#x1F600; &bogus; &nbsp;x"), "a & b <c> é — 😀 &bogus;  x");
eq("addresses: absolute, protocol-relative, rooted, relative, up a folder, a query", [resolveUrl("https://a.b/c/d.html", "https://x.y/z"), resolveUrl("https://a.b/c/d.html", "//cdn.b/s.js"), resolveUrl("https://a.b/c/d.html", "/root"), resolveUrl("https://a.b/c/d.html", "e/f"), resolveUrl("https://a.b/c/d.html", "../g"), resolveUrl("https://a.b/c/d.html", "?p=1")].join(" "), "https://x.y/z https://cdn.b/s.js https://a.b/root https://a.b/c/e/f https://a.b/g https://a.b/c/d.html?p=1");
eq("nowhere to read: a fragment, a script, mail", [resolveUrl("https://a.b/", "#top"), resolveUrl("https://a.b/", "javascript:void(0)"), resolveUrl("https://a.b/", "mailto:x@y")].join("|"), "||");

const page = htmlToMarkdown(
  '<html><head><title>The &amp; Page</title><style>p{}</style><script>var x = "<p>not this</p>";</script></head><body>' +
    '<nav><a href="/">Home</a> <a href="/about">About</a></nav><header><h1>Site</h1></header>' +
    '<h1>Getting started</h1><p>Install it with   <code>npm i x</code>, then read <a href="docs/guide.html">the <b>guide</b></a>.</p>' +
    "<ul><li>one</li><li>two<ul><li>two and a half</li></ul></li></ul><ol start=\"3\"><li>third</li><li>fourth</li></ol>" +
    "<pre><code>const a = 1;\n  indented();\n</code></pre>" +
    "<table><tr><th>Name</th><th>Size</th></tr><tr><td>a.txt</td><td>4 KB</td></tr></table>" +
    '<p>An image: <img src="x.png" alt="a cat"> and <img src="y.png"> none.<br>New line.</p>' +
    '<form><input name="q"><button>Go</button></form><footer>© 2026</footer><!-- a comment --></body></html>',
  "https://example.com/docs/index.html",
);
eq("the title", page.title, "The & Page");
eq(
  "the body as markdown, the navigation, header, form and footer left out",
  page.markdown,
  "# Getting started\n\nInstall it with `npm i x`, then read [the guide](https://example.com/docs/docs/guide.html).\n\n- one\n- two\n  - two and a half\n\n3. third\n4. fourth\n\n```\nconst a = 1;\n  indented();\n```\n\nName | Size |\na.txt | 4 KB |\n\nAn image: [image: a cat] and none.\nNew line.",
);

const long = "word ".repeat(60);
const withMain = htmlToMarkdown("<body><div>Menu stuff</div><main><h2>Article</h2><p>" + long + "</p></main><div>Sidebar</div></body>", "https://e.x/");
eq("a page's <main> when it holds enough", withMain.markdown.slice(0, 20) + "|" + String(withMain.markdown.includes("Menu")), "## Article\n\nword wor|false");
const withArticle = htmlToMarkdown("<body><div>Menu</div><article><p>" + long + "</p></article></body>", "https://e.x/");
eq("else its one <article>", String(withArticle.markdown.startsWith("word word") && !withArticle.markdown.includes("Menu")), "true");
eq("a short <main> is not the page", htmlToMarkdown("<body><p>Intro text.</p><main>tiny</main></body>", "https://e.x/").markdown, "Intro text.\n\ntiny");
done();
