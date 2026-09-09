# Awesome WebMCP 🤖 [![Awesome](https://awesome.re/badge-flat.svg)](https://awesome.re) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md) [![License: CC0-1.0](https://img.shields.io/badge/License-CC0_1.0-lightgrey.svg)](LICENSE)

> A curated list of websites, apps, and projects using **WebMCP** (Web Model Context Protocol), plus the SDKs, tools, and resources to build your own.

[WebMCP](https://github.com/webmachinelearning/webmcp) is a W3C proposal that lets web applications expose JavaScript-based tools to AI agents and assistive technologies. Sites register tools imperatively with `navigator.modelContext.registerTool()` or declaratively with HTML attributes, so agents can call real functions with full context, auth, and speed instead of scraping or clicking through the UI. The result is collaborative, human-in-the-loop workflows on the same page the human is looking at.

Two browsers implement WebMCP today. **Chrome 146+** shipped it as an [early preview](https://developer.chrome.com/blog/webmcp-epp) in February 2026, and the **ChatGPT desktop browser** added support for [WebMCP site tools](https://learn.chatgpt.com/docs/webmcp) in August 2026. Shopify turned it on for every storefront, Cloudflare added a one-toggle integration, and polyfills and browser extensions make it work everywhere else.

This list focuses on **real websites and apps that ship WebMCP tools**. If you built one, [add it](CONTRIBUTING.md)!

## Contents

- [Websites](#websites)
  - [Commerce](#commerce)
  - [Developer Tools and Infrastructure](#developer-tools-and-infrastructure)
  - [Productivity and Utilities](#productivity-and-utilities)
  - [Content, Media, and Personal Sites](#content-media-and-personal-sites)
  - [Finance and Legal](#finance-and-legal)
  - [Travel, Events, and Lifestyle](#travel-events-and-lifestyle)
- [Demos and Samples](#demos-and-samples)
- [Tools](#tools)
  - [Directories and Registries](#directories-and-registries)
  - [Browser Extensions](#browser-extensions)
  - [Developer Tooling](#developer-tooling)
- [SDKs and Libraries](#sdks-and-libraries)
- [Frameworks and Integrations](#frameworks-and-integrations)
  - [Platforms](#platforms)
  - [Server-side Frameworks](#server-side-frameworks)
  - [WordPress](#wordpress)
- [Benchmarks](#benchmarks)
- [Getting Started](#getting-started)
- [Tutorials](#tutorials)
- [Articles](#articles)
- [Blogs](#blogs)
- [Videos](#videos)
- [Presentations](#presentations)
- [Community](#community)
- [Related Lists](#related-lists)
- [Contributing](#contributing)
- [License](#license)

## Websites

Production websites and apps that expose WebMCP tools to agents. Entries are verified in the [webmcp.com directory](https://webmcp.com/) or by inspecting the live page.

### Commerce

- [Allbirds](https://www.allbirds.com/) - Footwear and apparel store on Shopify. Ships the standard Shopify storefront tool set: `search_catalog`, `browse_store`, `get_product`, `get_cart`, `update_cart`, `proceed_to_checkout`, `manage_orders`, and policy search.
- [Alo Yoga](https://www.aloyoga.com/) - Yoga and athletic apparel store with the Shopify storefront tool set for catalog search, cart, and checkout.
- [Away Travel](https://www.awaytravel.com/) - Direct-to-consumer luggage brand whose storefront is agent-shoppable through the Shopify tool set.
- [BestPrice.gr](https://www.bestprice.gr/) - Greek price-comparison marketplace with 12 tools for search, listing filters and sorting, offer comparison, product specs, and price history.
- [Brooklinen](https://www.brooklinen.com/) - Premium bedding retailer with the Shopify storefront tool set.
- [dupe.com](https://dupe.com/) - Designer-dupe finder for furniture, fashion, and beauty. Exposes a single `find_dupes` tool.
- [Glossier](https://www.glossier.com/) - Beauty and skincare brand with the Shopify storefront tool set.
- [Ippodo Tea](https://www.ippodotea.com/) - Kyoto tea merchant founded in 1717. Adds custom tools for tea recommendations, brewing guides, comparisons, and store lookup on top of the Shopify commerce tools.
- [Orshot](https://orshot.com/) - Creative automation suite for ad creatives, videos, and branded PDFs. Six public tools for template search and pricing plus signed-in workspace tools bridged from its hosted MCP server.
- [Reebok](https://www.reebok.com/) - Athletic footwear and apparel store with the Shopify storefront tool set.
- [sms-florin](https://flo-voice1.com/esim) - eSIM and virtual phone number store. WebMCP tools run on the live Stripe checkout flow, so an agent browses plans and completes a real purchase through the same code path a human uses ([source](https://github.com/flovoice53-tech/sms-florin-webmcp-demo)).

### Developer Tools and Infrastructure

- [admintoolkit.io](https://admintoolkit.io/) - A suite of 24 read-only WebMCP tools for infrastructure diagnostics, including a WebMCP tool validator.
- [agent-ready.dev](https://agent-ready.dev/) - Scores any website for AI-agent readability against the Vercel Agent Readability Spec, llms.txt, and agent-protocol manifests. Exposes `scan_site`, `get_scan`, and `ask` tools so in-browser agents can run scans directly.
- [Astronomer](https://astronomer.io/) - Managed Apache Airflow platform. Tools open docs, book a demo, and expose discovery endpoints.
- [Chainstack](https://chainstack.com/) - Blockchain infrastructure provider. Tools for site search, product listing, MCP server discovery, pricing, and contact options, pitched as "ask Gemini in Chrome right on the page".
- [Conscriba](https://conscriba.com/) - Automatic WebMCP creation for AI agents, plus analytics and tracking.
- [Customer.io](https://customer.io/) - Customer engagement platform. Tools open pages, start a free trial, and contact sales.
- [Fly.io](https://fly.io/) - App hosting platform. Tools for the Sprites quickstart, listing Fly resources, and navigation.
- [Glama](https://glama.ai/) - Directory of 10,000+ scanned and scored MCP servers. Exposes `search_mcp_servers` so an agent can query the index directly.
- [isainative.dev](https://isainative.dev/) - Audits public GitHub repositories for AI coding readiness and exposes both declarative and imperative WebMCP tools.
- [Nodecraft](https://nodecraft.com/) - Game server hosting. The NodePanel control panel exposes tools for console output, file editing, restarts, backups, and deploys, and the marketing site lists games, locations, and knowledge base results ([announcement](https://nodecraft.com/blog/development/letting-ai-agents-drive-your-game-servers-with-webmcp)).
- [Pixly](https://pixly.gg/) - Pay-per-uptime Minecraft server hosting. 22 tools cover the full server lifecycle: create, update, console logs, backups, restores, and world resets.
- [Render](https://render.com/) - Cloud hosting platform. Tools search the docs and fetch the docs, llms.txt, blog, and articles indexes as markdown.
- [Sentry](https://sentry.io/) - Application monitoring. Tools for signup, demo requests, pricing, docs search, and MCP server discovery.
- [Stacktree](https://stacktr.ee) - Agent-first HTML hosting. The dashboard and docs expose site-management tools (publish, update, gate, share) over WebMCP from a command palette, so humans and in-browser agents share one tool catalog.
- [Telnyx](https://telnyx.com/) - Communications and voice AI platform. Tools for asking questions, pricing, docs index, and site info.
- [turva.dev](https://turva.dev/) - Agent-readiness audits for websites, APIs and Shopify storefronts. Registers `get_services`, `get_company` and `get_contact` on every content page, and `get_services` returns the services page as markdown with machine-readable pricing beside it.
- [WordLift AI Audit](https://audit.wordlift.io/) - Agent-readiness auditor that exposes a `run-audit` tool so an agent can trigger a full 0 to 100 readiness analysis of any site.
- [WordPress Playground](https://playground.wordpress.net/) - WordPress running entirely in the browser via WebAssembly. 16 tools for PHP execution, HTTP requests, navigation, and filesystem operations ([source](https://github.com/WordPress/wordpress-playground/pull/3298)).
- [Yutori](https://yutori.com/) - Web-agent company behind the Navigator browsing model. Tools return an overview, model details, developer resources, and getting-started steps.
- [Zuplo](https://zuplo.com/) - Managed API gateway. Registers `search_docs` and `book_demo` and publishes its own [WebMCP explainer](https://zuplo.com/blog/what-is-webmcp).

### Productivity and Utilities

- [image2svg by Botmonster](https://botmonster.com/image2svg/) - Free in-browser image-to-SVG converter with WebMCP tools so an agent can run the conversion on-page.
- [JSON-stat WebMCP Explorer](https://jsonstat.com/webmcp/) - Fetches datasets from official statistical offices such as Eurostat, then filters, pivots, sorts, and exports CSV through 12 tools.
- [Kakeklar](https://kakeklar.no/) - Norwegian children's birthday-party planner. Tools configure a party and generate an age-aware shopping list ([source](https://github.com/webmaxru/barnebursdag-planlegger)).
- [Lectern](https://lectern.click/) - In-browser lesson builder. 40 tools let agents fill gaps, write sections, and add quiz items on the page the teacher sees.
- [QR Code Crafter](https://qrcodecrafter.com/) - Free QR generator for links, Wi-Fi, vCards, and payments. 13 tools, including verified generation that decodes and hash-checks every export against the requested payload.
- [QuokkaPix](https://quokkapix.com/) - Browser image editor for resize, crop, compress, convert, background removal, watermarking, and batch recipes. 14 tools.
- [Ranuts Document Editor](https://edit.chaxus.com/) - Client-side DOCX, XLSX, and PPTX editor that works offline. Tools open, create, save, and read documents ([source](https://github.com/ranuts/document)).
- [Scholar Sidekick](https://scholar-sidekick.com/integrations/webmcp) - Resolves scholarly identifiers (DOI, PMID, arXiv, ISBN) and verifies citations. Exposes seven WebMCP tools so in-browser agents can verify a citation, audit a bibliography, format citations, and check retraction and open-access status.
- [Sema](https://sema.run/) - A Lisp with first-class LLM primitives running entirely in WebAssembly. 17 tools for editing, running, and debugging code in the browser playground.
- [Simple Tool Stack](https://simpletoolstack.com/) - Browser-only image, text, and PDF utilities. 21 tools for compress, convert, crop, EXIF removal, PDF merge, split, and more.
- [SimplePDF AI](https://ai.simplepdf.com/) - Fill and sign PDFs in the browser. Five tools load documents, read content, list fields, and set field values.
- [SpeedOf.Me](https://speedof.me/m/) - Browser-based internet speed test. Tools run a test, create a share link, and fetch past results.
- [Toban](https://toban.app/) - Free duty-roster maker for cleaning, lunch, and daily-monitor rotation charts. 18 tools manage schedules, members, and rotations.
- [WebConverter](https://webconverter.app/webmcp.html) - Privacy-first, in-browser file converter (images, PDF, audio, video, OCR, 3D models). Every conversion is exposed as a WebMCP tool so agents can convert files locally with no uploads or API keys.

### Content, Media, and Personal Sites

- [Archipelago](https://warrenperez.com/en/archipelago/) - Maps a Notion workspace as a nautical chart, entirely in the browser. Four WebMCP tools let an agent draw the chart, read it back, highlight databases, and annotate islands on the same map the human is watching.
- [cloverbase.com](https://cloverbase.com/) - AI adoption mentorship site with site info, post listing, search, and newsletter tools. One of four sites made agent-ready in a day ([write-up](https://nz365guy.com/blog/four-websites-agent-ready-webmcp)).
- [Cocktail.glass](https://cocktail.glass/) - Cocktail recipe catalogue. Tools search by ingredient or movie scene, find what you can make from your shelf, and pull a random recipe.
- [Frase](https://www.frase.io/) - AI content and SEO platform. FraseCMS-hosted sites ship WebMCP automatically, with annotated forms as declarative tools plus a read-only "ask your site" tool ([explainer](https://www.frase.io/blog/what-is-webmcp)).
- [nz365guy.com](https://nz365guy.com/) - Mark Smith's blog on AI and Microsoft. Site overview, post listing, archive search, and human-confirmed subscription forms.
- [suganthan.com](https://suganthan.com/) - Personal site made agent-ready, with an accompanying [implementation guide](https://suganthan.com/blog/webmcp-implementation-guide/).
- [TweakTown](https://www.tweaktown.com/) - Tech news and hardware reviews. Tools search content, browse topics, and compare review data.
- [vietanh.dev](https://www.vietanh.dev/) - Developer blog with `search_content`, `get_post`, and an `ask_viet` RAG tool. The [accompanying post](https://www.vietanh.dev/blog/2026-07-06-webmcp-agent-ready-website) covers the WebMCP attack surface.
- [YubHub](https://yubhub.co/) - Recruitment job board with imperative and declarative tools for search, job fetch, browsing, and shortlisting ([write-up](https://dev.to/richardbaxter/implementing-webmcp-on-a-recruitment-website-19a)).

### Finance and Legal

- [Coinranking Pro Chart](https://coinranking.com/chart/coin/Qwsogvtv82FCd+bitcoin-btc/price) - Live crypto charting with drawing and technical-analysis tools. 17 WebMCP tools let an agent read series, manage drawings, and drive the viewport.
- [Corpus Law](https://corpuslaw.us/) - Company formation in all US states plus plain-English state and local law lookup. Eight tools for law search, formation drafts, NAICS lookup, and hand-off.
- [Longbridge](https://longbridge.com/) - US stock-trading platform. Eight tools for stock search, snapshots, fundamentals, analysis, and news.
- [Madrona](https://www.madrona.com/) - Venture capital firm. Eight tools list companies, insights, and team members, search content, and subscribe to the newsletter.
- [scvd.store](https://scvd.store/) - Evidence observatory for agentic commerce over x402 payments. Tools preflight endpoints, check conformance, verify artifacts, and search the catalog.
- [Settled Estate](https://settledestate.com/webmcp/) - County-specific probate guidance. Tools search estate guidance, compare online will makers, and open executor-compensation calculators.

### Travel, Events, and Lifestyle

- [Airport Lounge List](https://airportloungelist.com/) - Searchable database of 2,300+ airport lounges. Tools search lounges, list lounges by airport, and fetch details.
- [Fever](https://feverup.com/en) - Events and experiences marketplace. Tools list cities, navigate to a city, favorite plans, and summarize the page.
- [Spectrum Tours Prague](https://spectrumtours.cz/) - Prague tour operator whose tour pages expose a booking-preparation tool.

## Demos and Samples

Showcases, playgrounds, and sample apps built to demonstrate WebMCP.

- [Blackjack Agents](https://webmcp-blackjack.heejae.dev/) - Blackjack where player, opponent, and dealer are separate AI agents driven purely by tool descriptions ([source](https://github.com/happyhj/webmcp-blackjack)).
- [Cadence, Relay, and Consequence](https://cadence-webmcp.ashrafahmed1232.workers.dev/) - Three production-quality demos: an issue tracker with scoped tools on a shared undo stack, a [dispatch console](https://relay-webmcp.ashrafahmed1232.workers.dev/) with build-time enforced UI-to-tool parity, and an [application form](https://consequence-webmcp.ashrafahmed1232.workers.dev/) that structurally refuses to fill attestation fields ([source](https://github.com/AshrafAhmed9/cadence)).
- [Cesium Agent Lab](https://cesium-browser-agent.pages.dev/) - 3D geospatial lab built on CesiumJS with 61 tools for camera control, markers, models, and scene export ([source](https://github.com/gaopengbin/cesium-mcp)).
- [CliDeck MCP: Network Evidence Workbench](https://mcp.clideck.com/demo) - Live, read-only, version-aware network knowledge demo exposing deterministic lookup, change review, snapshot analysis, upgrade guidance, and topology analysis through WebMCP tools ([source](https://github.com/SmartRoot7/clideck-mcp)).
- [Flight Booking Demo](https://webmcp-flight-demo.netlify.app/) - Flight search with both imperative and [declarative](https://webmcp-flight-demo.netlify.app/declarative.html) variants for side-by-side comparison of the two APIs.
- [Google Chrome Labs demos](https://github.com/GoogleChromeLabs/webmcp-tools/#demos) - Official demos, including the [explainer](https://googlechromelabs.github.io/webmcp-tools/demos/explainer/) and the [React Flight Search](https://googlechromelabs.github.io/webmcp-tools/demos/react-flightsearch/) travel booking sample.
- [Open for Agents Storefront](https://demo.openforagents.com/) - Live WordPress and WooCommerce store with 27 owner-reviewed product-discovery tools ([plugin](https://wordpress.org/plugins/open-for-agents-ai-toolkit-with-mcp/)).
- [Panoptik Studio](https://panoptik-studio.vercel.app/) - Browser-native video editor where humans and agents co-edit the same canvas through 30 tools. No uploads, no server.
- [Shoe Store](https://andreinwald.github.io/webmcp-demo/) - React storefront with search, cart, and checkout exposed as WebMCP tools ([source](https://github.com/andreinwald/webmcp-demo)).
- [Telerik UI WebMCP Operations Hub](https://demos.telerik.com/blazor-ui/marketing-campaigns/webmcp-operations-hub) - Progress's Blazor demo where Grid, Map, Spreadsheet, Scheduler, and Form components auto-register 30 agent tools.
- [Third-party demos](https://github.com/GoogleChromeLabs/webmcp-tools/blob/main/AWESOME_WEBMCP.md#demos) - Community demos collected by Google Chrome Labs.
- [ucp.new](https://ucp.new/) - Playground for the Universal Commerce Protocol wired to a real Shopify catalog. Tools search the catalog, manage the cart, and create checkout permalinks.
- [WebMCP Text Editor](https://bandarra.me/apps/webmcp-text-editor/) - Text editor with 27 imperative tools for document I/O, workspace CRUD, on-device translation, and sub-agent delegation.
- [webmcp.dev](https://webmcp.dev) - Widget demo.
- [webmcp.sh](https://webmcp.sh/) - Playground backed by an in-browser PGlite Postgres database where an agent navigates the app and runs gateway operations ([source](https://github.com/WebMCP-org/webmcp-sh)).
- [WebMCP Flow](https://webmcp-flow.vercel.app/) - Architecture diagram builder where an agent creates nodes, connects edges, and applies auto-layout in real time ([source](https://github.com/ttimur-dev/webmcp-flow)).
- [WebMCP × Excalidraw](https://shidh.in/demo/webmcp-excalidraw/) - Turns natural language into Excalidraw diagrams via a generate, validate, render pipeline, with optional on-device generation using Chrome's built-in AI.
- [WSG WebMCP Experiment](https://mgifford.github.io/wsg-webmcp-experiment/) - An effort to learn about WebMCP by applying it to the [Web Sustainability Guidelines](https://github.com/w3c/sustainableweb-wsg).

### Netlify demos

- [Kurio](https://webmcp-kurio.netlify.app/) - Fictional marketplace where agents search products, add to cart, and complete a simulated checkout.
- [Mabel's Table](https://webmcp-mabels-table.netlify.app/) - Restaurant with real reservation state. Agents negotiate alternatives, place holds, confirm, and cancel bookings.
- [Tagboard](https://webmcp-tagboard.netlify.app/) - Public guestbook where agents read and post notes, with every write passing through an AI moderation layer.
- [The Archive](https://webmcp-archive.netlify.app/) - Detective mystery for humans and agents to solve together, where some clues are only reachable through registered tools.

### OpenAI reference apps

Sample apps from the [OpenAI Developers showcase](https://developers.openai.com/showcase/verdant-market) built for ChatGPT's browser.

- [Codex Modeling Studio](https://codex-modeling-studio.openai.chatgpt.site/) - Web-native 3D modeling suite where you guide the agent through each change.
- [Crossword Desk](https://crossword-desk-studio.openai.chatgpt.site/) - Turns a topic into a personalized crossword, then refines the clues collaboratively.
- [Cubecade](https://cubecade.openai.chatgpt.site/) - Arcade-style 3D puzzle cube fully controllable by an agent.
- [Fieldwork // 12](https://fieldwork-beat-machine.openai.chatgpt.site/) - Beat-making and music sequencing driven by an agent.
- [Margin Editor](https://margin-local-docs.openai.chatgpt.site/) - Local note-taking app for collaborating with an agent on documents.
- [Paperie](https://paperie-webmcp-greeting-cards.openai.chatgpt.site/) - Design greeting cards and artwork collaboratively.
- [Sunday Table](https://sundaytable.openai.chatgpt.site/) - Plan weekly meals, recipes, and groceries with an agent.
- [Verdant Market](https://verdant-market-grocery.openai.chatgpt.site/) - Grocery storefront where an agent browses products and builds a shared cart.
- [WanderNote](https://wandernote.openai.chatgpt.site/) - Plan a trip in a shared editable itinerary.
- [Webroom](https://webroom.openai.chatgpt.site/) - Agent-compatible photo editing in the browser.

## Tools

### Directories and Registries

- [webmcp.com](https://webmcp.com/) - Directory of 550+ WebMCP-enabled websites with a JSON API for agent-side discovery.
- [WebMCP Registry](https://webmcp-registry.dev) - Self-serve public directory with DNS TXT ownership verification and a public search API, built on the open-source `@webmcp-registry/kit` SDK ([source](https://github.com/WebMCP-Registry/kit)).
- [WebMCP Today](https://webmcp.today/) - Open-source package registry for discovering site-specific WebMCP packages and installing them with per-site install commands ([source](https://github.com/robertn702/webmcp-today)).

### Browser Extensions

- [MCP-B Browser Extension](https://chromewebstore.google.com/detail/mcp-b-extension/daohopfhkdelnpemnhlekblhnikhdhfa) - Chrome, Edge, and Firefox extension with a sidebar chat that discovers and calls WebMCP tools across tabs. Works without the Chrome flag.
- [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd) - Official Chrome Labs extension to inspect and execute the tools a page registers.
- [nekuda WebMCP Workbench](https://chromewebstore.google.com/detail/nekuda-webmcp-workbench/amochnnbmnkjjlblolhpddkokhnalkjp) - Devtools plus AI assistant: inspect, run, eval, and audit a page's tools, then chat with the site through them. BYOK or hosted Gemini.
- [Refraktor](https://chromewebstore.google.com/detail/refraktor/nkafbaaanaamfjdljndmieichdgkhgii) - Autonomous consumer agent that discovers and invokes a site's registered tools, with design-token drift checking.
- [WebMCP Bridge](https://chromewebstore.google.com/detail/webmcp-bridge/chgjbookknohehmaocfijekhaocaanaf) - Reads tools registered by pages and exposes them over MCP to desktop clients like Claude Code and Cursor.
- [WebMCP DevTools](https://chromewebstore.google.com/detail/webmcp-devtools/cgfogfkcfjdgpekdndcihajfjkaekjcl) - Side panel for inspecting, testing, and monitoring tools: schema visualization, generated forms, execution history, event timeline, and snapshot diffs.
- [WebMCP Developer Tools](https://chromewebstore.google.com/detail/webmcp-developer-tools/lhifnagdfoidbjdgdmghpbdpnphbompd) - Inspect, test, and debug tools on any site using the experimental `navigator.modelContextTesting` API.
- [WebMCP Extension](https://chromewebstore.google.com/detail/webmcp-extension/jigokfbbpcdckjmhbgapmikncfihboec) - Opens automatically when a page registers tools, shows what agents can do there, and lets you execute tools directly.
- [WebMCP Hub](https://chromewebstore.google.com/detail/webmcp-hub/ahblgfajboifhioeldnefolijmllkaaj) - Connects to a community registry of WebMCP configs and registers matching tools on sites that don't ship their own.
- [WebMCP Inspector](https://chromewebstore.google.com/detail/webmcp-inspector/ddmnodehiebeklbngpeeghmcohomfimd) - Developer-grade WebMCP diagnostics extension.
- [WebMCP Ready Checker](https://chromewebstore.google.com/detail/webmcp-ready-checker/gnjfbpnfgmllkpjhhohednepgffkmhhk) - Scans any page and validates its tools, contracts, forms, and security posture.

### Developer Tooling

- [Agent Lighthouse](https://forkpoint.github.io/agent-lighthouse/) - Lighthouse-style CLI, TypeScript engine, and MCP server for auditing website agent readiness ([source](https://github.com/ForkPoint/agent-lighthouse)).
- [AIC (Agent Interaction Control)](https://github.com/VPAI-Grok/AIC) - Open-source contracts, cross-surface evidence, parity verification, and fail-closed reliance checks for WebMCP tools and their human UI, MCP, and API equivalents.
- [auto-webmcp](https://github.com/prasanna-gyde/auto-webmcp) - Makes any HTML form WebMCP-ready with zero code changes.
- [autotel-webmcp](https://github.com/jagreehal/autotel) - OpenTelemetry instrumentation that traces in-page agent tool calls from the browser.
- [DeepDeck](https://github.com/jo32/DeepDeck) - MIT-licensed macOS desktop client that discovers and calls website-provided WebMCP tools. Its Builder explores a site, generates and verifies tools, and saves versioned per-site source.
- [gui-agent](https://github.com/aralroca/gui-agent) - Open-source in-page GUI agent that drives web apps through their registered tools.
- [isWebMCP](https://marketplace.visualstudio.com/items?itemName=UnifyDynamics.iswebmcp) - VS Code extension that audits a public web page for WebMCP actionability without leaving the editor.
- [Latch](https://latch.tools) - One-line script that detects a page's existing search, cart, and form handlers and registers them as WebMCP tools. MIT licensed, no framework dependency ([source](https://github.com/r0bertini/latch)).
- [MCP Webcomic Site Server](https://github.com/nearestnabors/mcp-webcomic-site-server) - Template and tutorial for making a webcomic archive agent-visible across an 11ty site, an MCP server, and WebMCP browser tools.
- [webmaxru/agent-skills: WebMCP](https://github.com/webmaxru/agent-skills/tree/main/skills/webmcp) - Agent skill for implementing and debugging browser WebMCP integrations in JavaScript and TypeScript web apps.
- [webmcp-attest](https://github.com/ElBartoTn/webmcp-attest) - Client-side drift detection that hashes the toolset a page exposes to agents, paired with a spec-faithful [polyfill](https://github.com/ElBartoTn/webmcp-polyfill).
- [WebMCP Bridge](https://h3manth.com/ai/webmcp/) - Bridges any remote MCP server into `document.modelContext`, letting in-browser agents invoke tools from existing MCP servers ([source](https://github.com/hemanth/mcp-web-bridge)).
- [webmcp-bridge (stdio)](https://github.com/Wisteria30/webmcp-bridge) - Exposes WebMCP tools from Chrome as a stdio MCP server for terminal and CLI coding agents.
- [WebMCP Checker](https://webmcp-checker.com/) - Free agent-readiness audit that scores a site and returns failed checks with copy-paste fix code.
- [webmcp-docs](https://github.com/link1345/webmcp-docs) - Exposes framework-agnostic documentation search through WebMCP so agents can query a site's docs directly.
- [WebMCP Inspector](https://webmcpinspector.com/) - Online inspector for testing and debugging WebMCP tool registrations.
- [webmcpify](https://github.com/TueJon/webmcpify) - Agent skill that integrates WebMCP into an existing web app end to end: inventories the app, proposes a tool manifest for approval, integrates the tools, then verifies each one in a real browser and heals failures.
- [WebMCP Kit](https://github.com/nekuda-ai/webmcp-kit) - Plugin for coding agents with an interactive visual Explorer that maps a site's user journeys to proposed WebMCP tools, then implements and verifies them in a real browser.
- [webmcp-profiler](https://github.com/lucaguglielmi/Unfolded-Web-MCP) - Drop-in performance analyser for WebMCP tool surfaces with per-call spans and payload and token accounting.
- [webmcp-proxy](https://github.com/alpic-ai/webmcp-proxy) - Proxies tools from a remote MCP server into the browser via WebMCP.
- [webmcp-verify](https://github.com/eralabs-ai/webmcp) - Drives Chrome with WebMCP enabled and verifies page tools for CI-style checks.
- [@agenticschema/browser](https://github.com/searchstefano/agenticschema) - Exposes a page's existing Schema.org markup as WebMCP tools with a single script tag.
- [@keak/webmcp-core](https://github.com/keak-ai/webmcp-core) - Auto-generates WebMCP tool definitions from any existing website.

## SDKs and Libraries

### JavaScript and TypeScript

- [agentk](https://github.com/stevysmith/agentk) - Command palette library (a cmdk fork) where tools defined once as JSON Schema become human-facing forms and WebMCP registrations. Handles the `navigator.modelContext` to `document.modelContext` move and AbortSignal-based unregistration.
- [fastwebmcp](https://github.com/MauricioPerera/fastwebmcp) - FastMCP-style ergonomics for WebMCP with typed builders over both the imperative and declarative APIs.
- [GoogleChromeLabs/webmcp-tools](https://github.com/GoogleChromeLabs/webmcp-tools) - Official collection of WebMCP tools, demos, and the tool inspector by Google Chrome Labs.
- [Janux](https://github.com/aralroca/Janux) - Fullstack framework for the agentic web with dual component interfaces: human UI plus agent tools.
- [MCP-B](https://mcp-b.ai/) - Complete open-source ecosystem by Alex Nahas: polyfill, React hooks (`@mcp-b/react-webmcp`), transports, and iframe bridging. See [npm packages](https://github.com/WebMCP-org/npm-packages), [examples](https://github.com/WebMCP-org/examples), [docs](https://docs.mcp-b.ai/), and the [WebMCP-org](https://github.com/WebMCP-org) organization.
- [opentiny/webmcp-sdk](https://github.com/opentiny/webmcp-sdk) - SDK implementing `document.modelContext` with a polyfill, from the OpenTiny team. See also [next-sdk](https://github.com/opentiny/next-sdk) with `WebMcpServer` and `WebMcpClient` classes and a Vue 3 chat UI.
- [Persona](https://www.persona-chat.dev/) - WebMCP-native, themeable agentic chat widget in vanilla JavaScript that drops into any site ([source](https://github.com/runtypelabs/persona)).
- [react-web-mcp](https://github.com/cr4yfish/react-web-mcp) - React hooks and components implementing the WebMCP standard.
- [react-webmcp-utils](https://github.com/apetcu/react-webmcp-utils) - React 18+ hooks paired with a lightweight [webmcp-polyfill](https://github.com/apetcu/webmcp-polyfill).
- [redux-webmcp](https://github.com/breeznik/redux-webmcp) - Semantic Redux bridge that makes Redux Toolkit state and actions legible to WebMCP agents.
- [Signett](https://signett.ai) - TypeScript SDK for registering app functions as WebMCP tools with JSON Schema validation, authorization, human confirmation, idempotency, and observability ([source](https://github.com/signettai/signett)).
- [simple-webmcp](https://github.com/emingure/simple-webmcp) - Turns existing JavaScript and TypeScript functions into callable WebMCP tools via `webmcp(fn)`, with schema patching, React lifecycle helpers, and execution hooks for approvals, HITL flows, and analytics.
- [use-webmcp-tool](https://github.com/GoogleChromeLabs/use-webmcp-tool) - Google Chrome Labs React hook for registering `document.modelContext` tools with lifecycle-managed registration.
- [vue-webmcp](https://github.com/MrSunshyne/vue-webmcp) - Vue composable for registering tools with lifecycle-managed cleanup, plus a companion `nuxt-webmcp` module.
- [WebMCP](https://github.com/jasonjmcghee/WebMCP) - An early open-source WebMCP project by Jason McGhee.
- [webmcp-react](https://github.com/agentcathq/webmcp-react) - React hooks for exposing app functionality as WebMCP tools.
- [@absolutejs/webmcp](https://github.com/absolutejs/webmcp) - Secure WebMCP registration with policy enforcement, audit logging, and test adapters.
- [@ashraf009/webmcp-kit](https://github.com/AshrafAhmed9/webmcp-kit) - Small typed library with `defineTool`, JSON Schema to TypeScript inference, `useWebMCPTool` and `useScopedTools` hooks, and `withConfirmation`. Powers the Cadence, Relay, and Consequence demos.
- [@web-ai-sdk/webmcp](https://github.com/obetomuniz/web-ai-sdk) - Zero-dependency, framework-agnostic adapter with lifecycle-safe cleanup, feature detection, and an optional React hook.
- [@webmcp-registry/kit](https://github.com/WebMCP-Registry/kit) - Define tools with Zod schemas, register them from React components, and sync tool contracts to the WebMCP Registry from CI.
- [@websem/angular](https://github.com/WebsemAI/Websem) - Angular WebMCP adapter for the Websem client toolkit.
- [@zap-studio/webmcp](https://github.com/zap-studio/monorepo) - Framework-agnostic, SSR-safe wrapper around the native `document.modelContext` API.
- [webmcpable](https://github.com/jagreehal/webmcpable) - Registers WebMCP tools that mirror exactly what the user can do right now in the UI, keeping tool surface and UI state in sync.
- [webmcp-types](https://github.com/webmachinelearning/webmcp-types) - Community TypeScript type definitions tracking the W3C WebMCP spec.

### Other Languages

- [chromedp/cdproto webmcp](https://pkg.go.dev/github.com/chromedp/cdproto/webmcp) - Go bindings for Chrome's WebMCP DevTools protocol domain, for programmatic inspection from Go.
- [flutter_webmcp](https://pub.dev/packages/flutter_webmcp) - Typed Dart API exposing Flutter Web actions as WebMCP tools, with AbortSignal cancellation and `exposedTo` origins ([source](https://github.com/KickNext/flutter_webmcp)).
- [intentcall_webmcp](https://pub.dev/packages/intentcall_webmcp) - Dart and Flutter WebMCP publish adapter for the intentcall registry ([source](https://github.com/Arenukvern/intentcall)).
- [webmcp (Ruby gem)](https://rubygems.org/gems/webmcp) - Define agent-callable tools once in Ruby and expose them to browsers via WebMCP ([source](https://github.com/seunghan91/webmcp)).
- [webmcp-rs](https://github.com/hauju/webmcp-rs) - Browser-side WebMCP tool registration for Rust and WebAssembly.

## Frameworks and Integrations

### Platforms

- [Shopify storefront tools](https://shopify.dev/docs/api/web-mcp) - Shopify ships ten WebMCP tools on every Liquid storefront with zero install: catalog search, product lookup, cart, checkout, orders, and policy search ([announcement](https://www.shopify.com/news/winter-26-edition-agentic-storefronts)).
- [Cloudflare WebMCP](https://blog.cloudflare.com/webmcp/) - Developer preview that gives any Cloudflare-proxied site a WebMCP interface through selectable tool packs, with no code change or redeploy. See also the [Workers starter](https://webmcp-challenge.examples.workers.dev/) and [Browser Rendering support](https://developers.cloudflare.com/browser-run/features/webmcp/).
- [ChatGPT site tools](https://learn.chatgpt.com/docs/webmcp) - OpenAI's docs for consuming WebMCP tools in the ChatGPT desktop browser.
- [Netlify WebMCP Starter](https://webmcp-starter.netlify.app/) - Prompt-first starter that an agent builds and deploys on Netlify Agent Runners. The deployed page registers WebMCP tools out of the box.
- [Telerik and Kendo UI](https://www.vktr.com/digital-experience/progress-software-adds-webmcp-support-and-agent-tools-to-telerik-and-kendo-ui/) - Progress added built-in WebMCP support to its Blazor and Kendo component suites, the first major enterprise UI toolkit to do so.
- [Wix WebMCP extension](https://github.com/tuvit/webmcp) - Wix platform extension that injects WebMCP attributes into Wix Stores pages.

### Server-side Frameworks

- [Active_WebMCP](https://github.com/benjis/Active_WebMCP) - Experimental Rails integration for explicitly selected, same-origin GET and POST browser tools.
- [agent-surface](https://agent-surface.dev) - Agent-surface framework with an experimental `@agent-surface/webmcp` transport adapter ([source](https://github.com/Wiseair-srl/agent-surface)).
- [astro-webmcp](https://github.com/freshjuice-dev/astro-webmcp) - Astro integration that exposes site content as WebMCP tools.
- [gofastr webmcp](https://pkg.go.dev/github.com/DonaldMurillo/gofastr/framework/experimental/webmcp) - Experimental WebMCP support in the gofastr Go web framework.
- [Shopware WebMCP Plugin](https://github.com/agentic-commerce-lab/webmcp-plugin) - Adds WebMCP support to storefronts built with Shopware, an open-source ecommerce platform.
- [TYPO3: neoblack/webmcp](https://github.com/NeoBlack/webmcp) - Declarative WebMCP tool framework for TYPO3. See also [brosua/typo3-webmcp](https://github.com/brosua/typo3-webmcp), which exposes forms and content as in-browser agent tools.
- [webmcp-django](https://github.com/seunghan91/webmcp-django) - Django integration: Origin-Trial token middleware and template tags for the declarative form API.
- [webmcp-go](https://github.com/seunghan91/webmcp-go) - Go `net/http` middleware that serves the WebMCP Origin-Trial token header.
- [webmcp-rails](https://github.com/jessewaites/webmcp-rails) - Adds declarative WebMCP attributes to Rails `form_with` and `form_for` via a `webmcp:` option.
- [WebMcpBundle](https://github.com/yoanbernabeu/WebMcpBundle) - Symfony bundle exposing routes as WebMCP tools via PHP attributes.
- [WebMCP-org/examples](https://github.com/WebMCP-org/examples) - Integration examples for React, Next.js, Remix, Angular, Vue, Svelte, and server-rendered stacks.

### WordPress

- [Agentgate for WebMCP](https://wordpress.org/plugins/agentgate-for-webmcp/) - Read-only access to posts and categories for agents in Chrome 146+.
- [BeeClear WebMCP AI Visibility](https://wordpress.org/plugins/beeclear-webmcp-ai-visibility/) - Exposes content and discovery endpoints so agents can understand a WordPress site.
- [Form Annotator for WebMCP](https://wordpress.org/plugins/silvaitamar-form-annotator-for-webmcp/) - Annotates forms with declarative WebMCP attributes so agents can fill lead and support forms reliably.
- [Open for Agents](https://wordpress.org/plugins/open-for-agents-ai-toolkit-with-mcp/) - Owner-reviewed product-discovery tools for WordPress and WooCommerce ([live demo](https://demo.openforagents.com/)).
- [Ostheimer Cockpit for WebMCP](https://wordpress.org/plugins/ostheimer-webmcp-cockpit/) - Lets browser agents write, edit, and manage posts with a human review step.
- [PW Feed Readiness Audit](https://wordpress.org/plugins/pw-feed-readiness-audit/) - Audits pages for declarative and imperative tools, quality issues, and security recommendations.
- [Respira for WordPress](https://github.com/respira-press/webmcp-for-wordpress) - Edit a WordPress site by asking. The agent reads the page, writes the change to a copy, and waits for approval before it reaches the live page ([live demo](https://chatgpt-respira.instawp.site)).
- [webmcp-abilities](https://github.com/code-atlantic/webmcp-abilities) - Bridges the WordPress Abilities API to `modelContext.registerTool()`.
- [WebMCP Bridge](https://wordpress.org/plugins/webmcp-bridge/) - Makes a WordPress site agent-friendly via WebMCP with no backend server required.
- [wmcp.dev](https://www.wmcp.dev/) - Plugin family adding declarative attributes to Contact Form 7, Gravity Forms, WPForms, Ninja Forms, and WooCommerce.
- [WP-WebMCP](https://github.com/kulkarnitech/WP-WebMCP) - Open-source WordPress WebMCP plugin.

## Benchmarks

- [WindTunnel](https://github.com/nekuda-ai/WindTunnel) - Open-source benchmark comparing WebMCP with other browser-agent interfaces across task success, execution time, token usage, and cost.

## Getting Started

- [WebMCP explainer](https://github.com/webmachinelearning/webmcp/blob/main/README.md) - Official explainer for web developers and authors.
- [WebMCP spec draft](https://webmachinelearning.github.io/webmcp/) - W3C Community Group draft specification for implementers.
- [WebMCP on Chrome for Developers](https://developer.chrome.com/docs/ai/webmcp) - Official Chrome documentation for the API.
- [Chrome WebMCP Early Preview announcement](https://developer.chrome.com/blog/webmcp-epp) - Google Chrome's announcement of the early preview program (February 2026).
- [Chrome Early Preview Program](https://developer.chrome.com/docs/ai/join-epp) - Join the EPP, then enable `chrome://flags/#enable-webmcp-testing` in Chrome 146+ Canary. See the [detailed instructions](https://docs.google.com/document/d/1rtU1fRPS0bMqd9abMG_hc6K9OAI6soUy3Kh00toAgyk/).
- [ChatGPT site tools](https://learn.chatgpt.com/docs/webmcp) - How the ChatGPT desktop browser discovers and calls WebMCP tools.
- [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-run/features/webmcp/) - Run headless Chrome with the WebMCP flag enabled in the cloud.

## Tutorials

- [Chrome WebMCP: The Complete 2026 Guide](https://dev.to/czmilo/chrome-webmcp-the-complete-2026-guide-to-ai-agent-protocol-1ae9) - End-to-end walkthrough of the API and how to add it to a site.
- [A deep dive into WebMCP](https://flaviocopes.com/webmcp/) - Flavio Copes' walkthrough of the imperative and declarative APIs.
- [A Guide to Web MCP](https://composio.dev/content/a-guide-to-web-mcp-how-websites-can-expose-tools-to-ai-agents) - Composio's guide to how websites expose tools to agents.
- [How to Use WebMCP with a Headless Agent Using Firecrawl](https://www.firecrawl.dev/blog/webmcp-headless-agents-firecrawl) - Driving WebMCP tools from Claude Code through Firecrawl.
- [Implementing WebMCP on a recruitment website](https://dev.to/richardbaxter/implementing-webmcp-on-a-recruitment-website-19a) - Richard Baxter on mixing imperative and declarative tools on YubHub.
- [Four websites agent-ready with WebMCP in a day](https://nz365guy.com/blog/four-websites-agent-ready-webmcp) - Mark Smith on retrofitting four production sites.
- [WebMCP: I Made My Website AI Agent Ready](https://suganthan.com/blog/webmcp-implementation-guide/) - Step-by-step implementation guide on a personal site.
- [Building an agent-ready website with WebMCP](https://www.vietanh.dev/blog/2026-07-06-webmcp-agent-ready-website) - Includes a thorough look at the WebMCP attack surface.
- [Implementing WebMCP at Orshot](https://orshot.com/blog/webmcp-implementation) - How a SaaS bridged its hosted MCP server into public and signed-in WebMCP tools.
- [MCP-B documentation](https://docs.mcp-b.ai/) - Full docs for the MCP-B polyfill, hooks, and extension.

## Articles

- 2026.08 [OpenAI Adds WebMCP Site Tools To ChatGPT's Browser](https://www.searchenginejournal.com/chatgpt-adds-webmcp-support/587237/) / Search Engine Journal.
- 2026.08 [OpenAI Adds WebMCP to ChatGPT's Browser](https://www.vktr.com/ai-platforms/openai-adds-webmcp-to-chatgpts-browser/) / VKTR. Names Shopify, Expedia, Instacart, Target, and Progress as adopters and experimenters.
- 2026.08 [Progress Software Adds WebMCP Support to Telerik and Kendo UI](https://www.vktr.com/digital-experience/progress-software-adds-webmcp-support-and-agent-tools-to-telerik-and-kendo-ui/) / VKTR.
- 2026.08 [Cloudflare Previews Automatic WebMCP Support for Web Pages](https://www.infoq.com/news/2026/08/cloudflare-webmcp/) / InfoQ.
- 2026.02 [Google Chrome ships WebMCP in early preview, turning every website into a structured tool for AI agents](https://venturebeat.com/infrastructure/google-chrome-ships-webmcp-in-early-preview-turning-every-website-into-a) by Sam Witteveen / VentureBeat.
- 2026.02 [Google Ships WebMCP: The Browser-Based Backbone for the Agentic Web](https://www.forbes.com/sites/joetoscano1/2026/02/19/google-ships-webmcp-the-browser-based-backbone-for-the-agentic-web/) by Joe Toscano / Forbes.
- 2026.02 [Google Chrome Launches WebMCP in Early Preview](https://www.eweek.com/news/google-webmcp-chrome-ai-web-standard-preview/) / eWeek.
- [WebMCP API extends web apps to AI agents](https://www.infoworld.com/article/4133366/webmcp-api-extends-web-apps-to-ai-agents.html) / InfoWorld.
- [WebMCP explained: Inside Chrome 146's agent-ready web preview](https://searchengineland.com/webmcp-explained-inside-chrome-146s-agent-ready-web-preview-470630) / Search Engine Land.

## Blogs

- 2026.09 [I added WebMCP to a live Stripe checkout in ~40 lines](https://dev.to/flovoice53tech/i-added-webmcp-to-a-live-stripe-checkout-in-40-lines-4ekk) by Florin Arsenie, on adding WebMCP to a product that already takes real money.
- 2026.08 [Give any website a WebMCP interface](https://blog.cloudflare.com/webmcp/) by Cloudflare, announcing the developer preview.
- 2026.08 [Introducing Shopify Agentic Storefronts](https://www.shopify.com/news/winter-26-edition-agentic-storefronts) by Shopify, turning on WebMCP for every Liquid storefront.
- 2026.08 [Breaking: Shopify Stores are Getting WebMCP](https://nekuda.substack.com/p/breaking-shopify-stores-are-getting) by nekuda. See also [WebMCP: Every Website Is Getting an Agent](https://nekuda.substack.com/p/webmcp-every-website-is-getting-an).
- 2026.08 [WebMCP: Teaching Your Website to Talk to AI Agents](https://sreenathmenon.com/blog/2026-08-04-webmcp-teaching-websites-to-talk-to-ai-agents/) by Sreenath Menon ([Hacker News discussion](https://news.ycombinator.com/item?id=49450417)).
- 2026.07 [The State of WebMCP: July 2026](https://www.spronta.com/blog/state-of-webmcp-july-2026/) by Spronta.
- 2026.05 [WebMCP Reality Check: Where the Spec Actually Stands](https://studiomeyer.io/en/blog/webmcp-reality-check-may-2026) by Studio Meyer.
- 2026.04 [Letting AI agents drive your game servers with WebMCP](https://nodecraft.com/blog/development/letting-ai-agents-drive-your-game-servers-with-webmcp) by Nodecraft.
- 2026.02 [WebMCP: The Web Standard That Makes Every Website a Tool for Agents](https://www.arcade.dev/blog/web-mcp-alex-nahas-interview) by RL Nabors, based on an interview with Alex Nahas.
- [WebMCP + Shopify: The AI Shopping Head Start Most Merchants Don't Know About](https://zelium.app/blogs/webmcp-shopify-agentic-commerce.html) by Zelium.
- [WebMCP Explained for Product Teams](https://departmentofproduct.substack.com/p/webmcp-explained-for-product-teams) / Department of Product.
- [What is WebMCP?](https://zuplo.com/blog/what-is-webmcp) by Zuplo.
- [What is WebMCP?](https://www.frase.io/blog/what-is-webmcp) by Frase.

## Videos

- 2026.04 [WebMCP Explained](https://www.youtube.com/watch?v=GbfZSjJBQQ0&list=PLNhYw8KaLq2ViBncoyLc2TSGOjzSqe8Pr) by Andrew Nolan, presented at the W3C AC Meeting 2026.
- 2026.04 [WebMCP and the Agentic Web](https://www.youtube.com/watch?v=M1cME470ugM) by [Dominic Farolino](https://domfarolino.com), presented at BlinkOn 21.
- 2026.02 [WebMCP: Agents on the Web and in the Browser](https://www.youtube.com/watch?v=6Po39iD6Pfs&t=31s) by Alex Nahas, interviewed by RL Nabors.
- 2025.11 [Web AI Summit 2025: Don't let AI agents push your buttons - use WebMCP instead!](https://www.youtube.com/watch?v=p1l8nkQAoUw) by Khushal Sagar.
- 2025.10 [WebMCP demo recording](https://screen.studio/share/hbGudbFm) by Alex Nahas, presented at W3C TPAC 2025.
- [The Rise of WebMCP](https://www.youtube.com/watch?v=35oWt7u2b-g) by Sam Witteveen.

## Presentations

- [W3C AC Meeting 2026: WebMCP Explained](https://www.youtube.com/watch?v=GbfZSjJBQQ0&list=PLNhYw8KaLq2ViBncoyLc2TSGOjzSqe8Pr) by Andrew Nolan.
- [BlinkOn 21: WebMCP and the Agentic Web](https://www.youtube.com/watch?v=M1cME470ugM) by Dominic Farolino.
- [W3C TPAC 2025 demo](https://screen.studio/share/hbGudbFm) by Alex Nahas.

## Community

- [W3C Web Machine Learning Community Group](https://www.w3.org/groups/cg/webmachinelearning/) - Develops the WebMCP spec ([how to join](https://webmachinelearning.github.io/community/#join)).
- [WebMCP GitHub repo](https://github.com/webmachinelearning/webmcp/) - Spec development and related technical discussions.
- [The WebMCP Challenge](https://webmcp.devpost.com/) - Hackathon run with Chrome, Cloudflare, Shopify, Vercel, Render, and Netlify (August to September 2026). Winners announced September 23, 2026.
- [MCP-B Discord](https://discord.gg/ZnHG4csJRB) - Community chat for the MCP-B ecosystem.
- Hacker News: [Ask HN: What Is the Point of WebMCP?](https://news.ycombinator.com/item?id=47085076), [Show HN: webmcp-kit](https://news.ycombinator.com/item?id=47027976), [Show HN: webmcp-react](https://news.ycombinator.com/item?id=47263145), [WebMCP + CDP MCP server](https://news.ycombinator.com/item?id=46223714).

## Related Lists

- [webmachinelearning/awesome-webmcp](https://github.com/webmachinelearning/awesome-webmcp) - The list maintained by the W3C Web Machine Learning Community Group.
- [Leanmcp/awesome-webmcp](https://github.com/Leanmcp/awesome-webmcp) - The list maintained by LeanMCP.
- [yigitkonur/awesome-webmcp](https://github.com/yigitkonur/awesome-webmcp) - Another community list covering specs, SDKs, demos, and platform integrations.
- [GoogleChromeLabs AWESOME_WEBMCP.md](https://github.com/GoogleChromeLabs/webmcp-tools/blob/main/AWESOME_WEBMCP.md) - Third-party demos and tools collected by Google Chrome Labs.

## Contributing

Built a site or app with WebMCP? Found something awesome? Open an issue or a pull request. Please read the [contributing guidelines](CONTRIBUTING.md) and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[![CC0](https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/cc-zero.svg)](https://creativecommons.org/publicdomain/zero/1.0)

To the extent possible under law, the contributors have waived all copyright and related or neighboring rights to this work.
