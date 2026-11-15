// A session's title from its opening, asked of the provider's cheapest model with the prompt the
// agent package names Claude Code's sessions with.
import { TITLE_SYSTEM, cleanTitle } from "../../agent/titles.ts";
import { Abort } from "../loop/abort.ts";
import { ModelClient, ModelRequest, StreamListener } from "../model/client.ts";
import { END_TURN, Message, textPart } from "../model/message.ts";
import { ModelRegistry } from "../model/registry.ts";

const CHEAP: Record<string, string> = { anthropic: "anthropic/claude-haiku-4-5", deepseek: "deepseek/deepseek-flash" };

/** The model that names sessions for the one `model` runs on. */
export const namingModel = (registry: ModelRegistry, model: string): string => {
  const m = registry.model(model);
  const cheap = m !== null ? (CHEAP[m.provider] ?? "") : "";
  return cheap.length > 0 && registry.model(cheap) !== null ? cheap : model;
};

/** A title for a session that opened with `prompt` and `reply` ("" when the model gave none). */
export const titleFor = async (client: ModelClient, registry: ModelRegistry, model: string, prompt: string, reply: string): Promise<string> => {
  const user = new Message("user", "t1");
  user.parts.push(textPart("<session>\n<user>\n" + prompt.slice(0, 2000) + "\n</user>\n<assistant>\n" + reply.slice(0, 600) + "\n</assistant>\n</session>"));
  const req = new ModelRequest(namingModel(registry, model), [TITLE_SYSTEM], [user]);
  let text = "";
  const l = new StreamListener();
  l.onText = (d: string) => {
    text += d;
  };
  const end = await client.stream(req, l, new Abort());
  return end.stopReason === END_TURN ? cleanTitle(text) : "";
};
