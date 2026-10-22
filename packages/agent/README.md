# @widecode/agent

`mcp.ts` is `McpServer`, an app's own tools served to the agents the user runs over MCP (streamable HTTP on 127.0.0.1, a token per agent plugin, the config file an agent is started with); the app names it.

The `claude -p` sidecar shared by the apps: `ClaudeAgent` spawns the CLI with `AgentOptions` (the flags of a run, `cleanEnv` the `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT` wrapper) over stream-json in and out, `decodeEnvelope` turns each line into an `AgentEvent` (init, system, text deltas, assistant, result, stderr, exit, malformed), `LineSplitter` comes from `@light/lib`. The shapes follow Claude Code 2.1; `test/fixtures/stream.ndjson` is a recorded run.
