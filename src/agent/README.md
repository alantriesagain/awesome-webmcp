# src/agent

`mcp.ts` is `McpServer`, an app's own tools served to the agents the user runs over MCP (streamable HTTP on 127.0.0.1, a token per agent plugin, the config file an agent is started with); the app names it. `answer` caps a `tools/call` result at `resultLimit` (40,000 characters by default) with `capResult`: a longer answer keeps its first 30,000 and last 8,000 characters around a paragraph saying how much was cut, and the cut is written to the run's log with the tool's name and both sizes.

The `claude -p` sidecar: `ClaudeAgent` spawns the CLI with `AgentOptions` (the flags of a run, `cleanEnv` the `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT` wrapper) over stream-json in and out, `decodeEnvelope` turns each line into an `AgentEvent` (init, system, text deltas, assistant, result, stderr, exit, malformed), `LineSplitter` comes from `@light/lib`. The shapes follow Claude Code 2.1; `test/fixtures/stream.ndjson` is a recorded run.
