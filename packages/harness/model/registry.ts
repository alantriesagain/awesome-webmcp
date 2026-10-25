// The models the harness offers, by provider: the Anthropic Messages API's own models (the
// claude-api reference, cached 2026-06-24) and DeepSeek's through its Anthropic-format endpoint
// (its pricing page, peak rates; off-peak is half), each with its window, output cap, prices per
// million tokens, how thinking is asked for (`adaptive` with an effort on current Anthropic
// models, a `budget` on Haiku 4.5 and DeepSeek, `none`) and the efforts it takes. A configured
// provider adds its own rows.

export const ADAPTIVE = "adaptive";
export const BUDGET = "budget";
export const NO_THINKING = "none";

export class Provider {
  readonly id: string;
  readonly name: string;
  baseUrl: string;
  /** The environment variable the key comes from. */
  keyEnv: string;
  /** Whether the API takes Anthropic's own extras: cache breakpoints, eager input streaming, the effort. */
  anthropicExtras: boolean;

  constructor(id: string, name: string, baseUrl: string, keyEnv: string, anthropicExtras: boolean) {
    this.id = id;
    this.name = name;
    this.baseUrl = baseUrl;
    this.keyEnv = keyEnv;
    this.anthropicExtras = anthropicExtras;
  }
}

export class ModelInfo {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  window = 200000;
  maxOutput = 64000;
  /** Dollars per million tokens: input, output, a cache read, a cache write (below 0: unknown). */
  inputPrice = -1;
  outputPrice = -1;
  cacheReadPrice = -1;
  cacheWritePrice = -1;
  thinking = NO_THINKING;
  efforts: string[] = [];

  constructor(provider: string, id: string, name: string) {
    this.provider = provider;
    this.id = id;
    this.name = name;
  }

  /** `provider/id`, the value the options carry. */
  value(): string {
    return this.provider + "/" + this.id;
  }
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const anthropic = (id: string, name: string, input: number, output: number, window: number, thinking: string, efforts: string[]): ModelInfo => {
  const m = new ModelInfo("anthropic", id, name);
  m.window = window;
  m.maxOutput = 64000;
  m.inputPrice = input;
  m.outputPrice = output;
  m.cacheReadPrice = input * 0.1;
  m.cacheWritePrice = input * 1.25;
  m.thinking = thinking;
  m.efforts = efforts;
  return m;
};

const deepseek = (id: string, name: string, input: number, output: number, cacheRead: number, vision: boolean): ModelInfo => {
  const m = new ModelInfo("deepseek", id, name + (vision ? "" : ""));
  m.window = 1000000;
  m.maxOutput = 64000;
  m.inputPrice = input;
  m.outputPrice = output;
  m.cacheReadPrice = cacheRead;
  m.cacheWritePrice = input;
  m.thinking = BUDGET;
  m.efforts = ["low", "medium", "high"];
  return m;
};

export class ModelRegistry {
  readonly providers: Provider[] = [];
  readonly models: ModelInfo[] = [];

  /** The built-in providers and models. */
  static builtIn(): ModelRegistry {
    const r = new ModelRegistry();
    r.providers.push(new Provider("anthropic", "Anthropic", "https://api.anthropic.com", "ANTHROPIC_API_KEY", true));
    r.providers.push(new Provider("deepseek", "DeepSeek", "https://api.deepseek.com/anthropic", "DEEPSEEK_API_KEY", false));
    r.models.push(anthropic("claude-opus-5", "Claude Opus 5", 5, 25, 1000000, ADAPTIVE, EFFORTS));
    r.models.push(anthropic("claude-sonnet-5", "Claude Sonnet 5", 2, 10, 1000000, ADAPTIVE, EFFORTS));
    r.models.push(anthropic("claude-fable-5-1", "Claude Fable 5.1", 10, 50, 1000000, ADAPTIVE, EFFORTS));
    r.models.push(anthropic("claude-opus-4-8", "Claude Opus 4.8", 5, 25, 1000000, ADAPTIVE, EFFORTS));
    r.models.push(anthropic("claude-sonnet-4-6", "Claude Sonnet 4.6", 3, 15, 1000000, ADAPTIVE, ["low", "medium", "high", "max"]));
    r.models.push(anthropic("claude-haiku-4-5", "Claude Haiku 4.5", 1, 5, 200000, BUDGET, ["off", "low", "medium", "high"]));
    r.models.push(deepseek("deepseek-v4-pro", "DeepSeek V4 Pro", 1.32, 3.96, 0.044, false));
    r.models.push(deepseek("deepseek-flash", "DeepSeek Flash", 0.3, 1.2, 0.006, true));
    return r;
  }

  provider(id: string): Provider | null {
    for (const p of this.providers) if (p.id === id) return p;
    return null;
  }

  /** The model `value` names (`provider/id`), or null. */
  model(value: string): ModelInfo | null {
    for (const m of this.models) if (m.value() === value) return m;
    return null;
  }

  /** The first model of `provider`, or null. */
  firstOf(provider: string): ModelInfo | null {
    for (const m of this.models) if (m.provider === provider) return m;
    return null;
  }
}

/** The cost in dollars of `usage` on `m` (below 0 when a price is unknown). */
export const costUsd = (m: ModelInfo, input: number, output: number, cacheRead: number, cacheWrite: number): number => {
  if (m.inputPrice < 0 || m.outputPrice < 0) return -1;
  const read = m.cacheReadPrice < 0 ? m.inputPrice : m.cacheReadPrice;
  const write = m.cacheWritePrice < 0 ? m.inputPrice : m.cacheWritePrice;
  return (input * m.inputPrice + output * m.outputPrice + cacheRead * read + cacheWrite * write) / 1000000;
};

/** The `budget_tokens` for an effort on a model that takes a budget (0: thinking off). */
export const budgetFor = (effort: string): number => (effort === "off" ? 0 : effort === "low" ? 2048 : effort === "medium" ? 8192 : effort === "high" ? 16384 : 32000);
