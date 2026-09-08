# Awesome WebMCP 🤖 [![Awesome](https://awesome.re/badge-flat.svg)](https://awesome.re) [![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md) [![License: CC0-1.0](https://img.shields.io/badge/License-CC0_1.0-lightgrey.svg)](LICENSE)

> A curated list of websites, apps, and projects using **WebMCP** (Web Model Context Protocol), plus the SDKs, tools, and resources to build your own.

[WebMCP](https://github.com/webmachinelearning/webmcp) is a W3C proposal that lets web applications expose JavaScript-based tools to AI agents and assistive technologies. Sites register tools imperatively with `navigator.modelContext.registerTool()` or declaratively with HTML attributes, so agents can call real functions with full context, auth, and speed instead of scraping or clicking through the UI. The result is collaborative, human-in-the-loop workflows on the same page the human is looking at.

WebMCP shipped as an **early preview in Chrome 146+ Canary** (February 2026). Polyfills and browser extensions make it work in other browsers today.

This list focuses on **real websites and apps that ship WebMCP tools**. If you built one, [add it](CONTRIBUTING.md)!

## Contents

- [Websites](#websites)
- [Demos and Samples](#demos-and-samples)
- [Tools](#tools)
- [SDKs and Libraries](#sdks-and-libraries)
- [Frameworks and Integrations](#frameworks-and-integrations)
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

Production websites and apps that expose WebMCP tools to agents.

- [admintoolkit.io](https://admintoolkit.io/) - A suite of 24 read-only WebMCP tools for infrastructure diagnostics, including a WebMCP tool validator.
- [agent-ready.dev](https://agent-ready.dev/) - Scores any website for AI-agent readability against the Vercel Agent Readability Spec, llms.txt, and agent-protocol manifests. Exposes `scan_site`, `get_scan`, and `ask` tools so in-browser agents can run scans directly.
- [Archipelago](https://warrenperez.com/en/archipelago/) - Maps a Notion workspace as a nautical chart, entirely in the browser. Four WebMCP tools let an agent draw the chart, read it back, highlight databases, and annotate islands on the same map the human is watching.
- [Conscriba](https://conscriba.com/) - Automatic WebMCP creation for AI agents, plus analytics and tracking.
- [isainative.dev](https://isainative.dev/) - Audits public GitHub repositories for AI coding readiness and exposes both declarative and imperative WebMCP tools.
- [Scholar Sidekick](https://scholar-sidekick.com/integrations/webmcp) - Resolves scholarly identifiers (DOI, PMID, arXiv, ISBN) and verifies citations. Exposes seven WebMCP tools so in-browser agents can verify a citation, audit a bibliography, format citations, and check retraction and open-access status.
- [sms-florin](https://flo-voice1.com/esim) - eSIM and virtual phone number store. WebMCP tools run on the live Stripe checkout flow, so an agent browses plans and completes a real purchase through the same code path a human uses ([source](https://github.com/flovoice53-tech/sms-florin-webmcp-demo)).
- [Stacktree](https://stacktr.ee) - Agent-first HTML hosting. The dashboard and docs expose site-management tools (publish, update, gate, share) over WebMCP from a command palette, so humans and in-browser agents share one tool catalog.
- [WebConverter](https://webconverter.app/webmcp.html) - Privacy-first, in-browser file converter (images, PDF, audio, video, OCR, 3D models). Every conversion is exposed as a WebMCP tool so agents can convert files locally with no uploads or API keys.

## Demos and Samples

Showcases, playgrounds, and sample apps built to demonstrate WebMCP.

- [CliDeck MCP: Network Evidence Workbench](https://mcp.clideck.com/demo) - Live, read-only, version-aware network knowledge demo exposing deterministic lookup, change review, snapshot analysis, upgrade guidance, and topology analysis through WebMCP tools ([source](https://github.com/SmartRoot7/clideck-mcp)).
- [Google Chrome Labs demos](https://github.com/GoogleChromeLabs/webmcp-tools/#demos) - Official demos, including the [React Flight Search](https://googlechromelabs.github.io/webmcp-tools/demos/react-flightsearch/) travel booking sample.
- [Third-party demos](https://github.com/GoogleChromeLabs/webmcp-tools/blob/main/AWESOME_WEBMCP.md#demos) - Community demos collected by Google Chrome Labs.
- [webmcp.dev](https://webmcp.dev) - Widget demo.
- [WSG WebMCP Experiment](https://mgifford.github.io/wsg-webmcp-experiment/) - An effort to learn about WebMCP by applying it to the [Web Sustainability Guidelines](https://github.com/w3c/sustainableweb-wsg).

## Tools

Directories, agents, extensions, and developer tooling for working with WebMCP.

- [AIC (Agent Interaction Control)](https://github.com/VPAI-Grok/AIC) - Open-source contracts, cross-surface evidence, parity verification, and fail-closed reliance checks for WebMCP tools and their human UI, MCP, and API equivalents.
- [Ask nekuda](https://chromewebstore.google.com/detail/ask-nekuda/amochnnbmnkjjlblolhpddkokhnalkjp) - Chrome side-panel AI assistant that picks up WebMCP tools exposed by the active tab. BYOK or hosted Gemini.
- [MCP-B Browser Extension](https://chromewebstore.google.com/detail/mcp-b-extension/daohopfhkdelnpemnhlekblhnikhdhfa) - Chrome, Edge, and Firefox extension with a sidebar chat that discovers and calls WebMCP tools across tabs. Works without the Chrome flag.
- [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd) - Official Chrome Labs extension to inspect and execute the tools a page registers.
- [webmaxru/agent-skills: WebMCP](https://github.com/webmaxru/agent-skills/tree/main/skills/webmcp) - Agent skill for implementing and debugging browser WebMCP integrations in JavaScript and TypeScript web apps.
- [webmcp.com](https://webmcp.com/) - Live directory of WebMCP-enabled websites with a JSON API for agent-side discovery.
- [webmcpify](https://github.com/TueJon/webmcpify) - Agent skill that integrates WebMCP into an existing web app end to end: inventories the app, proposes a tool manifest for approval, integrates the tools, then verifies each one in a real browser and heals failures.
- [WebMCP Kit](https://github.com/nekuda-ai/webmcp-kit) - Plugin for coding agents with an interactive visual Explorer that maps a site's user journeys to proposed WebMCP tools, then implements and verifies them in a real browser.
- [WebMCP Today](https://webmcp.today/) - Open-source package registry for discovering site-specific WebMCP packages and installing them with per-site install commands ([source](https://github.com/robertn702/webmcp-today)).

## SDKs and Libraries

- [agentk](https://github.com/stevysmith/agentk) - Command palette library (a cmdk fork) where tools defined once as JSON Schema become human-facing forms and WebMCP registrations. Handles the `navigator.modelContext` to `document.modelContext` move and AbortSignal-based unregistration.
- [GoogleChromeLabs/webmcp-tools](https://github.com/GoogleChromeLabs/webmcp-tools) - Official collection of WebMCP tools, demos, and the tool inspector by Google Chrome Labs.
- [LeanMCP SDK](https://github.com/LeanMCP/leanmcp-sdk) - TypeScript and Python decorators plus managed edge deployment with OAuth, rate limiting, logs, and analytics.
- [MCP-B](https://mcp-b.ai/) - Complete open-source ecosystem by Alex Nahas: polyfill, React hooks (`@mcp-b/react-webmcp`), transports, and iframe bridging. See [npm packages](https://github.com/WebMCP-org/npm-packages), [examples](https://github.com/WebMCP-org/examples), [docs](https://docs.mcp-b.ai/), and the [WebMCP-org](https://github.com/WebMCP-org) organization.
- [simple-webmcp](https://github.com/emingure/simple-webmcp) - Turns existing JavaScript and TypeScript functions into callable WebMCP tools via `webmcp(fn)`, with schema patching, React lifecycle helpers, and execution hooks for approvals, HITL flows, and analytics.
- [WebMCP](https://github.com/jasonjmcghee/WebMCP) - An early open-source WebMCP project by Jason McGhee.

## Frameworks and Integrations

- [Shopware WebMCP Plugin](https://github.com/agentic-commerce-lab/webmcp-plugin) - Adds WebMCP support to storefronts built with Shopware, an open-source ecommerce platform.
- [webmcp-django](https://github.com/seunghan91/webmcp-django) - Django integration: Origin-Trial token middleware and template tags for the declarative form API.
- [webmcp-go](https://github.com/seunghan91/webmcp-go) - Go `net/http` middleware that serves the WebMCP Origin-Trial token header.
- [WebMCP-org/examples](https://github.com/WebMCP-org/examples) - Integration examples for React, Next.js, Remix, Angular, Vue, Svelte, and server-rendered stacks.

## Benchmarks

- [WindTunnel](https://github.com/nekuda-ai/WindTunnel) - Open-source benchmark comparing WebMCP with other browser-agent interfaces across task success, execution time, token usage, and cost.

## Getting Started

- [WebMCP explainer](https://github.com/webmachinelearning/webmcp/blob/main/README.md) - Official explainer for web developers and authors.
- [WebMCP spec draft](https://webmachinelearning.github.io/webmcp/) - W3C Community Group draft specification for implementers.
- [Chrome WebMCP Early Preview announcement](https://developer.chrome.com/blog/webmcp-epp) - Google Chrome's announcement of the early preview program (February 2026).
- [Chrome Early Preview Program](https://developer.chrome.com/docs/ai/join-epp) - Join the EPP, then enable `chrome://flags/#enable-webmcp-testing` in Chrome 146+ Canary. See the [detailed instructions](https://docs.google.com/document/d/1rtU1fRPS0bMqd9abMG_hc6K9OAI6soUy3Kh00toAgyk/).
- [Cloudflare Browser Rendering](https://developers.cloudflare.com/browser-run/features/webmcp/) - Run headless Chrome with the WebMCP flag enabled in the cloud.

## Tutorials

- [Chrome WebMCP: The Complete 2026 Guide](https://dev.to/czmilo/chrome-webmcp-the-complete-2026-guide-to-ai-agent-protocol-1ae9) - End-to-end walkthrough of the API and how to add it to a site.
- [MCP-B documentation](https://docs.mcp-b.ai/) - Full docs for the MCP-B polyfill, hooks, and extension.

## Articles

- 2026.02 [Google Chrome ships WebMCP in early preview, turning every website into a structured tool for AI agents](https://venturebeat.com/infrastructure/google-chrome-ships-webmcp-in-early-preview-turning-every-website-into-a) by Sam Witteveen / VentureBeat.
- 2026.02 [Google Ships WebMCP: The Browser-Based Backbone for the Agentic Web](https://www.forbes.com/sites/joetoscano1/2026/02/19/google-ships-webmcp-the-browser-based-backbone-for-the-agentic-web/) by Joe Toscano / Forbes.
- [WebMCP explained: Inside Chrome 146's agent-ready web preview](https://searchengineland.com/webmcp-explained-inside-chrome-146s-agent-ready-web-preview-470630) / Search Engine Land.

## Blogs

- 2026.09 [I added WebMCP to a live Stripe checkout in ~40 lines](https://dev.to/flovoice53tech/i-added-webmcp-to-a-live-stripe-checkout-in-40-lines-4ekk) by Florin Arsenie, on adding WebMCP to a product that already takes real money.
- 2026.02 [WebMCP: The Web Standard That Makes Every Website a Tool for Agents](https://www.arcade.dev/blog/web-mcp-alex-nahas-interview) by RL Nabors, based on an interview with Alex Nahas.
- [WebMCP Explained for Product Teams](https://departmentofproduct.substack.com/p/webmcp-explained-for-product-teams) / Department of Product.

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
- [MCP-B Discord](https://discord.gg/ZnHG4csJRB) - Community chat for the MCP-B ecosystem.
- [LeanMCP Discord](https://discord.com/invite/DsRcA3GwPy) - Community chat for LeanMCP.

## Related Lists

- [webmachinelearning/awesome-webmcp](https://github.com/webmachinelearning/awesome-webmcp) - The list maintained by the W3C Web Machine Learning Community Group.
- [Leanmcp/awesome-webmcp](https://github.com/Leanmcp/awesome-webmcp) - The list maintained by LeanMCP.

## Contributing

Built a site or app with WebMCP? Found something awesome? Open an issue or a pull request. Please read the [contributing guidelines](CONTRIBUTING.md) and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[![CC0](https://mirrors.creativecommons.org/presskit/buttons/88x31/svg/cc-zero.svg)](https://creativecommons.org/publicdomain/zero/1.0)

To the extent possible under law, the contributors have waived all copyright and related or neighboring rights to this work.
