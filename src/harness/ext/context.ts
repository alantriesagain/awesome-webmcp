// What every extension callback gets as `ctx`: the folder and mode, the model, the turn's abort,
// the context's size and the system prompt, and the session the call belongs to. `hasUI` is true
// when the client said it takes `_widecode/ui` and the call names a session; the ui calls then go
// to the client, and otherwise answer pi's no-UI defaults and log.
export class ExtContext {
  /** The id the host gave this call's context (0 before a call). */
  ctxId = 0;
  /** The extension instance the call belongs to (0 for none). */
  instanceId = 0;
  /** The session the call belongs to ("" when none, which keeps `hasUI` false). */
  sessionId = "";
  cwd = "";
  mode = "rpc";
  hasUI = false;
  /** The model as `provider/id` ("" for none). */
  modelValue = "";
  systemPrompt = "";
  tokens = 0;
  window = 0;
  aborted = false;
  idle = true;
  abort: (() => void) | null = null;

  provider(): string {
    const at = this.modelValue.indexOf("/");
    return at >= 0 ? this.modelValue.slice(0, at) : "";
  }

  modelId(): string {
    const at = this.modelValue.indexOf("/");
    return at >= 0 ? this.modelValue.slice(at + 1) : this.modelValue;
  }
}
