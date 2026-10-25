// The harness's settings: the `harness` section of the store's config.json (the model and effort a
// session starts on, when to compact, which HTTP path, the providers the user adds), read once at
// start. The project's prompt and trust do not come from here: the ACP client passes them with
// each session and prompt.
//
//   "harness": { "model": "anthropic/claude-sonnet-5", "effort": "high", "compactAt": 200000, "http": "node",
//     (a provider with "api": "openai" speaks chat completions; a model's "api", "baseUrl", "thinking": "toggle" | "effort", "reasoningField")
//     "search": { "order": ["searxng", "google", "brave", "tavily"], "searxng": "http://127.0.0.1:8080" },
//     "browser": { "command": "" },
//     "providers": { "mine": { "name": "Mine", "baseUrl": "https://host/anthropic", "keyEnv": "MINE_API_KEY",
//       "models": [{ "id": "big", "name": "Big", "context": 200000, "output": 32000, "price": [1, 4] }] } } }
import { readTextOr } from "@light/lib/fs.ts";
import { rulesIn } from "./tools/permissions.ts";
import { listOf, num, parseJson, recordOf, str, strs } from "@light/lib/json.ts";
import { ADAPTIVE, BUDGET, EFFORT, ModelInfo, ModelRegistry, NO_THINKING, OPENAI_API, Provider, TOGGLE, effortsFor } from "./model/registry.ts";

export class HarnessConfig {
  /** `provider/model`; "" for the first model the registry offers. */
  model = "";
  effort = "";
  /** The context size, in tokens, past which the session is compacted. */
  compactAt = 200000;
  /** "node" or "curl": how a model is streamed. */
  http = "node";
  /** The section's `providers`, as JSON text ("" for none), applied to a registry with `addProviders`. */
  providersJson = "";
  /** `search.order` (the backends WebSearch tries, [] for the default), `search.searxng` (an instance's address), `browser.command` (the browser, "" to find one). */
  searchOrder: string[] = [];
  searxng = "";
  browserCommand = "";
  /** The config's `permissions.deny`: the calls the harness refuses. */
  denyRules: string[] = [];

  /** The section as config.json at `path` has it; defaults where it says nothing. */
  static read(path: string): HarnessConfig {
    const c = new HarnessConfig();
    c.denyRules = rulesIn(path);
    const root = recordOf(parseJson(readTextOr(path, "{}")));
    const section = root !== null ? recordOf(root["harness"]) : null;
    if (section === null) return c;
    c.model = str(section["model"]);
    c.effort = str(section["effort"]);
    const at = num(section["compactAt"], 0);
    if (at > 0) c.compactAt = at;
    const http = str(section["http"]);
    if (http === "curl" || http === "node") c.http = http;
    const providers = recordOf(section["providers"]);
    if (providers !== null) c.providersJson = JSON.stringify(providers);
    const search = recordOf(section["search"]);
    if (search !== null) {
      c.searchOrder = strs(search["order"]);
      c.searxng = str(search["searxng"]);
    }
    const browser = recordOf(section["browser"]);
    if (browser !== null) c.browserCommand = str(browser["command"]);
    return c;
  }

  /** The configured providers and their models added to `r` (an id of a built-in provider replaces its base URL and key variable). */
  addProviders(r: ModelRegistry): void {
    const providers = recordOf(parseJson(this.providersJson.length > 0 ? this.providersJson : "{}"));
    if (providers === null) return;
    for (const id of Object.keys(providers)) {
      const p = recordOf(providers[id]);
      if (p === null) continue;
      let provider = r.provider(id);
      if (provider === null) {
        provider = new Provider(id, str(p["name"]).length > 0 ? str(p["name"]) : id, str(p["baseUrl"]), str(p["keyEnv"]).length > 0 ? str(p["keyEnv"]) : id.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_API_KEY", p["anthropicExtras"] === true);
        if (str(p["api"]) === OPENAI_API) provider.api = OPENAI_API;
        r.providers.push(provider);
      } else {
        if (str(p["baseUrl"]).length > 0) provider.baseUrl = str(p["baseUrl"]);
        if (str(p["keyEnv"]).length > 0) provider.keyEnv = str(p["keyEnv"]);
        if (typeof p["anthropicExtras"] === "boolean") provider.anthropicExtras = p["anthropicExtras"] === true;
      }
      for (const v of listOf(p["models"])) {
        const m = recordOf(v);
        if (m === null || str(m["id"]).length === 0) continue;
        const info = new ModelInfo(id, str(m["id"]), str(m["name"]).length > 0 ? str(m["name"]) : str(m["id"]));
        const window = num(m["context"], 0);
        if (window > 0) info.window = window;
        const output = num(m["output"], 0);
        if (output > 0) info.maxOutput = output;
        const price = listOf(m["price"]);
        if (price.length >= 2) {
          info.inputPrice = num(price[0], -1);
          info.outputPrice = num(price[1], -1);
          info.cacheReadPrice = price.length > 2 ? num(price[2], info.inputPrice) : info.inputPrice;
          info.cacheWritePrice = info.inputPrice;
        }
        if (str(m["api"]).length > 0) info.api = str(m["api"]);
        if (str(m["baseUrl"]).length > 0) info.baseUrl = str(m["baseUrl"]);
        if (str(m["reasoningField"]).length > 0) info.reasoningField = str(m["reasoningField"]);
        // Thinking as the model's API asks for it: by default a budget on an Anthropic-format API, nothing on a chat completions one.
        const chat = (info.api.length > 0 ? info.api : provider.api) === OPENAI_API;
        const thinking = str(m["thinking"]);
        const known = chat ? [TOGGLE, EFFORT, NO_THINKING] : [ADAPTIVE, BUDGET, NO_THINKING];
        info.thinking = known.includes(thinking) ? thinking : chat ? NO_THINKING : BUDGET;
        info.efforts = effortsFor(info.thinking);
        r.models.push(info);
      }
    }
  }
}
