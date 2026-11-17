// The shapes every ACP module works with: a conversation event, a JSON-RPC message (or any object in
// one) whose fields are all unknown, and the util readers obj, str, list and parse.

export type Ev = widecode.ConversationEvent;

/** A JSON-RPC message, or any object in one, every field unknown. */
export interface Msg {
  [key: string]: unknown;
}

export const { obj, str, list, parse } = widecode.util;
