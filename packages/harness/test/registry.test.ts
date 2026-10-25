// The registry and the costs: the built-in rows, a model by value, the cost of a usage from the
// prices (cache reads and writes at their rates), no cost without a price; the config's providers
// added, a built-in one's URL replaced; the keys: the environment first, then the file, written
// readable by the user alone.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../auth.ts";
import { HarnessConfig } from "../config.ts";
import { ModelInfo, ModelRegistry, Provider, budgetFor, costUsd } from "../model/registry.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const r = ModelRegistry.builtIn();
eq("the providers", r.providers.map((p) => p.id + ":" + p.baseUrl).join(" "), "anthropic:https://api.anthropic.com deepseek:https://api.deepseek.com/anthropic opencode:https://opencode.ai/inference/openai/v1");
const opus = r.model("anthropic/claude-opus-5");
ok("a model by value", opus !== null && opus.name === "Claude Opus 5" && opus.window === 1000000 && opus.thinking === "adaptive");
if (opus === null) throw new Error("no opus");
eq("the cost of a usage: input, output, a cache read at a tenth, a write at 1.25", costUsd(opus, 1000000, 100000, 1000000, 100000).toFixed(4), (5 + 2.5 + 0.5 + 0.625).toFixed(4));
const bare = new ModelInfo("x", "y", "Y");
eq("no cost without a price", String(costUsd(bare, 1, 1, 0, 0)), "-1");
eq("the budgets by effort", ["off", "low", "medium", "high", "max"].map(budgetFor).join(","), "0,2048,8192,16384,32000");
eq("the first model of a provider", r.firstOf("deepseek")?.id ?? "none", "deepseek-v4-pro");

const folder = mkdtempSync(join(tmpdir(), "harness-registry-"));
const config = new HarnessConfig();
config.providersJson = JSON.stringify({ mine: { name: "Mine", baseUrl: "https://mine.example/anthropic", models: [{ id: "big", name: "Big", context: 300000, price: [1, 4] }, { id: "plain", thinking: "none" }] }, deepseek: { baseUrl: "http://127.0.0.1:9/anthropic" } });
config.addProviders(r);
const mine = r.provider("mine");
ok("a configured provider with its models and key variable", mine !== null && mine.keyEnv === "MINE_API_KEY" && r.model("mine/big")?.window === 300000 && r.model("mine/big")?.outputPrice === 4 && r.model("mine/plain")?.thinking === "none" && (r.model("mine/plain")?.efforts.length ?? 1) === 0);
eq("a built-in provider's URL replaced", r.provider("deepseek")?.baseUrl ?? "", "http://127.0.0.1:9/anthropic");

const auth = new Auth(join(folder, "auth.json"));
const p = new Provider("mine", "Mine", "", "HARNESS_TEST_KEY", true);
eq("no key anywhere", auth.keyFor(p), "");
auth.writeKey("mine", "sk-file");
eq("the file's key", auth.keyFor(p), "sk-file");
eq("readable by the user alone", (statSync(join(folder, "auth.json")).mode & 0o777).toString(8), "600");
auth.writeKey("other", "sk-other");
eq("another provider's key beside it", readFileSync(join(folder, "auth.json"), "utf8"), '{"mine":{"key":"sk-file"},"other":{"key":"sk-other"}}\n');
process.env["HARNESS_TEST_KEY"] = "sk-env";
eq("the environment first", auth.keyFor(p), "sk-env");
rmSync(folder, { recursive: true, force: true });
done();
