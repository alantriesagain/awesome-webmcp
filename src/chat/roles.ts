// The roles the chat column and the Tools tab play for the other plugins: classes with no-op
// methods the plugin playing the role overrides (an app holds one of each, replaced when the
// plugin playing it goes).
import type { Composer } from "./composer.ts";

/** The Tools tab, as the chat uses it. */
export class ToolsTarget {
  /** The plugin playing the role ("" for none). */
  owner = "";

  /** Show the Tools tab with call `id` selected and in view, without going there. */
  reveal(_id: string): void {}
}

/** The chat column, as other plugins use it. */
export class ChatTarget {
  /** The plugin playing the role ("" for none). */
  owner = "";
  /** The composer, while the role is played (null: none). */
  composer: Composer | null = null;

  /** Show the conversation from its end (it was resumed or replaced). */
  showChat(): void {}

  /** Send `text` as a message to the agent (commands included), never as an answer to an open request. */
  submit(_text: string): void {}

  /** A line the user typed in the composer: kept for ↑ (unless it answers a question or plan), then submitted. */
  typed(_text: string): void {}

  /** Show request `id` in the request panel, the chat column focused. */
  showRequest(_id: string): void {}
}
