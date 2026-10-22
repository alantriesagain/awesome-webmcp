// The desktop harness's bridge: what the page may call and what the backend emits. Both sides
// import this file; the page gets `call.<method>` as Promises and `on(<event>, …)` typed by it.

/** The backend's answer to `send`: the agent was (re)started, or why it could not be. */
export interface SendResult {
  started: boolean;
  error: string;
}

export interface SessionInfo {
  model: string;
  resume: string;
  tools: boolean;
  selftest: boolean;
}

export interface HarnessApi {
  /** What the backend was launched with. */
  session(): SessionInfo;
  /** Send one user turn, starting the Claude sidecar first when it is not running. */
  send(text: string): SendResult;
  /** End the sidecar; the next `send` starts a new one. */
  stop(): void;
  /** Close the window and exit. */
  quit(): void;
}

export interface HarnessEvents {
  init: { sessionId: string; model: string; tools: number; version: string };
  delta: { text: string };
  assistant: { text: string };
  result: { subtype: string; isError: boolean; numTurns: number; costUsd: number; result: string; errors: string };
  status: { subtype: string; status: string };
  stderr: { text: string };
  error: { message: string };
  exit: { code: number };
}
