// The plugin API's JS side, as widecode's parts of it: the namespaces each beside its answers
// (src/api/<namespace>.ts), in the order the api object lists them, the namespace the runtime answers
// itself (actions) declared here, and the members that are no namespace (on, tell, note, every,
// after) as text where they sit. @light/plugins builds the prelude around them.
import { PreludePart } from "@light/plugins/prelude.ts";
import { NAMESPACE_AGENTS, NAMESPACE_CONVERSATION, NAMESPACE_AGENT } from "../api/agent.ts";
import { NAMESPACE_FS } from "../api/fs.ts";
import { NAMESPACE_GIT } from "../api/git.ts";
import { NAMESPACE_PEERS } from "../api/peers.ts";
import { NAMESPACE_PLUGINS, NAMESPACE_HARNESS } from "../api/plugins.ts";
import { NAMESPACE_PROCESS } from "../api/process.ts";
import { NAMESPACE_SESSIONS, NAMESPACE_STORE, NAMESPACE_TITLES } from "../api/sessions.ts";
import { NAMESPACE_SETTINGS, NAMESPACE_STATE } from "../api/state.ts";
import { NAMESPACE_TOOLS } from "../api/tools.ts";
import { NAMESPACE_COMMANDS, NAMESPACE_KEYS, NAMESPACE_UI, NAMESPACE_CLIPBOARD, NAMESPACE_LANGUAGES, NAMESPACE_FILES } from "../api/ui.ts";
import { NAMESPACE_CODE, NAMESPACE_COMPOSER, NAMESPACE_CHAT, NAMESPACE_WIDGETS } from "../api/widgets.ts";
import { HostAnswer } from "@light/plugins/engine.ts";
import type { JsRuntime } from "./runtime.ts";
import { answerAgent } from "../api/agent.ts";
import { answerSessions } from "../api/sessions.ts";
import { answerWidgets } from "../api/widgets.ts";
import { answerUi } from "../api/ui.ts";
import { answerState } from "../api/state.ts";
import { answerGit } from "../api/git.ts";
import { answerPeers } from "../api/peers.ts";
import { answerProcess } from "../api/process.ts";
import { answerFs } from "../api/fs.ts";
import { answerTools } from "../api/tools.ts";
import { answerPlugins } from "../api/plugins.ts";

/** The `actions` namespace of the plugin API, its JS side: the calls the runtime answers itself. */
export const NAMESPACE_ACTIONS = new PreludePart("actions", `        focus: (column) => call("focus", String(column)),
        showPanel: (panel) => call("showPanel", String(panel)),
        quit: () => call("quit"),
        openFolder: (path) => call("openFolder", String(path)),
        loadFiles: () => later("loadFiles", id),
        loadStatus: () => later("loadStatus", id),
        setBase: (base, kind, name) => call("setBase", String(base), String(kind), String(name)),
        relative: (path) => call("relative", String(path)),
`);

/** The members of the api object a plugin gets, in order. */
export const PARTS: PreludePart[] = [
  NAMESPACE_COMMANDS,
  NAMESPACE_KEYS,
  new PreludePart("", `      on: (hook, f) => call("on", id, String(hook), fn((...args) => { f(...args); })),
      tell: (text) => call("tell", String(text)),
      note: (text) => call("note", String(text)),
`),
  NAMESPACE_SETTINGS,
  NAMESPACE_UI,
  NAMESPACE_PROCESS,
  NAMESPACE_AGENTS,
  NAMESPACE_FS,
  NAMESPACE_CONVERSATION,
  NAMESPACE_TOOLS,
  new PreludePart("", `      every: (ms, f) => call("every", id, Number(ms), fn(() => { f(); })),
      after: (ms, f) => call("after", id, Number(ms), once(() => { f(); })),
`),
  NAMESPACE_STATE,
  NAMESPACE_PLUGINS,
  NAMESPACE_HARNESS,
  NAMESPACE_ACTIONS,
  NAMESPACE_CODE,
  NAMESPACE_COMPOSER,
  NAMESPACE_CHAT,
  NAMESPACE_CLIPBOARD,
  NAMESPACE_WIDGETS,
  NAMESPACE_LANGUAGES,
  NAMESPACE_FILES,
  NAMESPACE_GIT,
  NAMESPACE_PEERS,
  NAMESPACE_SESSIONS,
  NAMESPACE_STORE,
  NAMESPACE_TITLES,
  NAMESPACE_AGENT,
];

/** One namespace group and the file that answers it; a namespace not here is answered by the runtime itself. */
export class ApiNamespace {
  readonly names: string[];
  readonly answer: (rt: JsRuntime, name: string, a: unknown[]) => HostAnswer | null;

  constructor(names: string[], answer: (rt: JsRuntime, name: string, a: unknown[]) => HostAnswer | null) {
    this.names = names;
    this.answer = answer;
  }
}

/** Every namespace a file answers; runtime.ts walks this instead of keeping its own prefix list. */
export const API_ANSWERS: ApiNamespace[] = [
  new ApiNamespace(["agent", "agents", "conversation"], answerAgent),
  new ApiNamespace(["sessions", "store", "titles"], answerSessions),
  new ApiNamespace(["code", "chat", "composer", "widgets"], answerWidgets),
  new ApiNamespace(["ui", "keys", "commands", "languages", "files", "clipboard"], answerUi),
  new ApiNamespace(["state", "settings"], answerState),
  new ApiNamespace(["git"], answerGit),
  new ApiNamespace(["peers"], answerPeers),
  new ApiNamespace(["process"], answerProcess),
  new ApiNamespace(["fs"], answerFs),
  new ApiNamespace(["tools"], answerTools),
  new ApiNamespace(["plugins", "harness"], answerPlugins),
];
