# Contribution Guidelines

Thanks for taking the time to contribute! :+1:

Please note that this project is released with a [Contributor Code of Conduct](CODE_OF_CONDUCT.md). By participating in this project you agree to abide by its terms.

## How can I contribute?

If you know of a publicly available WebMCP project, tool, SDK, demo, article, video, or other resource that would be useful to the WebMCP community, please open an issue or submit a pull request. For now we only accept changes to `README.md`, which links out to external resources.

### Adding a new entry

1. Search the list first to make sure the resource is not already included.
2. Make one pull request per resource. This keeps review quick and discussion focused.
3. Add the entry to the most fitting section. If no section fits, propose a new one in the PR description.
4. Follow the entry format described below.
5. Use a clear PR title, such as `Add simple-webmcp` or `Add WebMCP Explained talk`.
6. In the PR description, briefly explain why the resource belongs in the list and note any affiliation you have with it.

### Entry format

```markdown
- [Name](https://link) - Short description ending with a period.
```

- Keep descriptions to one or two sentences. Describe what the resource does, not how great it is.
- Do not repeat the name in the description.
- Start the description with a capital letter and end it with a period.
- Link to the canonical source: the project repository, the official docs, or the original publication.
- For dated content (articles, blogs, videos), prefix the entry with the publication date as `YYYY.MM` and keep the section in reverse chronological order.
- Keep other sections in alphabetical order by name, unless an existing ordering is clearly intentional.
- Use a hyphen (`-`) as the separator between the link and the description.
- When a live site has open source, add it as `([source](https://link))` at the end of the description.

### Quality bar

Entries should be:

- **About WebMCP.** The resource must directly use, implement, explain, or evaluate WebMCP. General MCP or browser-agent resources are out of scope unless they cover WebMCP specifically.
- **Publicly accessible.** No paywalled, gated, or invite-only content.
- **Working and maintained.** Projects should build and run. Demos should load. Dead links will be removed.
- **Not purely promotional.** Products are welcome if they genuinely expose or support WebMCP tools. Landing pages with no WebMCP content are not.

## What is out of scope?

- Content that violates the [Code of Conduct](CODE_OF_CONDUCT.md).
- Resources that are not publicly available.
- Technical contributions to the WebMCP specification itself. Those happen in the [webmachinelearning/webmcp](https://github.com/webmachinelearning/webmcp) repository. To contribute to the spec, [join the W3C Web Machine Learning Community Group](https://webmachinelearning.github.io/community/#join).

## Removing or updating entries

If a resource is no longer maintained, has moved, or no longer relates to WebMCP, open an issue or a PR explaining the change. Fixing broken links and typos is always appreciated and does not need an issue first.

## Review process

A maintainer will review your PR and may ask for small changes to fit the list's conventions. Once approved, it will be merged and your contribution will appear in the list.

Thank you for helping build the agentic web!
