// How big the context is, estimated: four characters to a token, which the loop corrects with the
// last request's real count (the estimate covers what was added since).
import { IMAGE, Message } from "../model/message.ts";

/** An image counts as this many tokens. */
const IMAGE_TOKENS = 1500;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** A message's tokens: its parts' text, a call's input, an image's share, a few for the framing. */
export const messageTokens = (m: Message): number => {
  let n = 4;
  for (const p of m.parts) n += estimateTokens(p.text) + estimateTokens(p.inputJson) + (p.kind === IMAGE || p.data.length > 0 ? IMAGE_TOKENS : 0);
  return n;
};

export const messagesTokens = (messages: Message[]): number => {
  let n = 0;
  for (const m of messages) n += messageTokens(m);
  return n;
};
