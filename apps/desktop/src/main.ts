// The desktop harness: the chat screen as a light page in the system web view, the Claude
// sidecar behind the bridge. Build and run: light-native desktop desktop; flags as the terminal harness
// (--log, --resume, --model, --system-prompt-file, --claude, --tools) plus:
//   --web <dir>     the page's directory (default: web/ beside the executable)
//   --selftest      start a turn on connect, exit 0 once it completed and the page saw it
import { readFileSync } from "node:fs";
import { AgentOptions } from "@widecode/agent";
import { argValue, hasArg, log, nameLog, openLog } from "@light/lib/log.ts";
import { AgentService } from "./agent-service.ts";
import { DesktopApp, str } from "@lightstart/light/native/desktop";

/** The system prompt a run starts with, unless --system-prompt-file names one. */
export const DEFAULT_SYSTEM_PROMPT =
  "You are a writing partner inside a terminal writing tool. Help the user draft, revise and tighten prose. " +
  "Be concrete and brief; when asked to rewrite, return only the rewritten text.";

nameLog("harness-desktop");
openLog(argValue("--log"));

const opts = new AgentOptions();
const promptFile = argValue("--system-prompt-file");
opts.systemPrompt = promptFile !== null ? readFileSync(promptFile, "utf8") : DEFAULT_SYSTEM_PROMPT;
opts.model = argValue("--model");
opts.resume = argValue("--resume");
opts.tools = hasArg("--tools") ? null : "";
opts.permissionMode = hasArg("--tools") ? "dontAsk" : null;
const exe = argValue("--claude");
if (exe !== null) opts.executable = exe;
const selftest = hasArg("--selftest");

const app = new DesktopApp({ title: "writing harness", width: 900, height: 640, selectable: true });
const service = new AgentService(opts);
let resultSeen = false;
let pageSawResult = false;

const finishSelftest = (): void => {
  if (!selftest || !resultSeen || !pageSawResult) return;
  console.log("selftest ok");
  log("selftest ok");
  app.quit();
};

service.onEmit = (name, value) => app.emit(name, value);
service.onResult = (subtype, isError) => {
  if (!selftest) return;
  if (subtype === "success" && !isError) {
    resultSeen = true;
    setTimeout(finishSelftest, 0);
  } else {
    console.log("selftest failed: result " + subtype);
    process.exit(1);
  }
};

// A handler's value is typed `unknown` before it is wrapped: natively a Promise of an object
// literal type does not convert to the `Promise<unknown>` the route slot expects.
app.handle("session", () => {
  const info: unknown = { model: opts.model ?? "", resume: opts.resume ?? "", tools: opts.tools === null, selftest };
  return Promise.resolve(info);
});
app.handle("send", (args) => {
  const text = str(args, 0);
  const error = service.ensureStarted();
  const failed: unknown = { started: false, error };
  if (error.length > 0) return Promise.resolve(failed);
  service.send(text);
  const sent: unknown = { started: true, error: "" };
  return Promise.resolve(sent);
});
app.handle("stop", () => {
  service.stop();
  return Promise.resolve(null);
});
app.handle("quit", () => {
  setTimeout(() => app.quit(), 0);
  return Promise.resolve(null);
});
app.onLog = (level, text) => {
  log("page " + level + ": " + text);
  if (text === "saw result") {
    pageSawResult = true;
    finishSelftest();
  }
};
app.onConnect = () => {
  log("page connected");
  if (selftest) {
    const error = service.ensureStarted();
    if (error.length > 0) {
      console.log("selftest failed: " + error);
      process.exit(1);
    }
    service.send("Reply with exactly: PONG");
  }
};
app.onClose = () => {
  log("window closed");
  service.stop();
};
if (selftest)
  setTimeout(() => {
    console.log("selftest timed out: result=" + String(resultSeen) + " page=" + String(pageSawResult));
    process.exit(1);
  }, 90000);
app.start();
log("started");
