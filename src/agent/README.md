# src/agent

`mcp.ts` is `McpServer`, an app's own tools served to the agents the user runs over MCP (streamable HTTP on 127.0.0.1, a token per agent plugin, the config file an agent is started with); the app names it. `answer` caps a `tools/call` result at `resultLimit` (40,000 characters by default) with `capResult`: a longer answer keeps its first 30,000 and last 8,000 characters around a paragraph saying how much was cut, and the cut is written to the run's log with the tool's name and both sizes.

`executable.ts` is `claudeExecutable`: the Claude Code CLI lightcode runs itself, for the session titles (`titles.ts`, `claude -p` with a cheap model, no tools, nothing saved). The conversation with Claude Code is the claude plugin's (`plugins/claude`), over the plugin API.
