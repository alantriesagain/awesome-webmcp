// An agent widecode talks to, behind one role: Claude Code (widecode's plugins/claude/index.ts), or one a
// plugin brings. The conversation (conversation/conversation.ts) holds what is the same for every
// agent (the model, the status, the session's title and record) and hands the agent what the user
// does; the agent starts its process, writes what the user sends as its agent expects, reads its
// agent's messages into the conversation's model, and keeps its agent's sessions. The methods do
// nothing here: an adapter overrides them, as the other roles (host/contributions.ts) are played.
import type { Conversation } from "./conversation.ts";
import { Item } from "./model.ts";
import { Reply } from "./requests.ts";

/** An image to send: its media type, its base64 data, and the file it was read from ("" when none). */
export class ImageBlock {
  mediaType: string;
  data: string;
  /** The file the image came from: a chip's press opens it ("" when the image has no file). */
  path: string;

  constructor(mediaType: string, data: string, path = "") {
    this.mediaType = mediaType;
    this.data = data;
    this.path = path;
  }
}

/** A value the agent lets the user choose (a model, an effort, a mode), and its name on the screen. */
export class Option {
  value: string;
  name: string;

  constructor(value: string, name: string) {
    this.value = value;
    this.name = name;
  }
}

/** What the agent lets the user choose. An agent that takes any model name it is given (Claude Code's aliases) says so; another names its models when it knows them. */
export class Choices {
  anyModel = false;
  models: Option[] = [];
  efforts: Option[] = [];
  modes: Option[] = [];
}

export class Agent {
  /** The plugin that brought it ("" for the core's). */
  owner = "";

  /** Play the agent for `conversation` (one a plugin brought moves with /open to the next folder's). */
  attach(_conversation: Conversation): void {}

  /** Its id in config.json and `--agent` ("claude"), and its name as the screen says it ("Claude"). */
  id(): string {
    return "";
  }

  name(): string {
    return "the agent";
  }

  /** Whether its process runs; started and silent so far (it loads the session it resumes). */
  started(): boolean {
    return false;
  }

  /** Start the process and its session now, before any message, when the agent does that (its models and efforts come with its session); "" or why it could not. */
  prepare(): string {
    return "";
  }

  starting(): boolean {
    return false;
  }

  /** The models, efforts and modes it offers. */
  choices(): Choices {
    return new Choices();
  }

  /** Forget the session and stop the process: the next message starts a new one. */
  reset(): void {}

  /** Show session `id` in the model; the next message resumes it. */
  resume(_id: string): void {}

  /** Read the part of the session before the part shown; false when there is none. */
  loadEarlier(): boolean {
    return false;
  }

  /** Read what the subagent that call `item` ran did into the call; false when it is not kept. */
  loadSubagent(_item: Item): boolean {
    return false;
  }

  /** The session's id as the agent named it, "" before it did. */
  sessionId(): string {
    return "";
  }

  /** A line from the agent's process, as if it had written it (tests, replays). */
  receive(_line: string): void {}

  /** Send a message; "" or why it could not. */
  send(_text: string, _images: ImageBlock[], _from: string = ""): string {
    return "no agent";
  }

  interrupt(): void {}

  /** A message from a plugin's app part to that plugin's agent part; false when the agent has no such channel. */
  toAgentPart(_plugin: string, _type: string, _data: unknown): boolean {
    return false;
  }

  /** Switch the agent's mode ("plan", …); "" or why not. */
  setMode(_mode: string): string {
    return "no agent";
  }

  /** The model or effort for this session, live when the process runs, else for its start. */
  setModel(_name: string): void {}

  setEffort(_level: string): void {}

  /** Answer request `item` with the user's reply. */
  respond(_item: Item, _reply: Reply): void {}

  /** Take back the messages queued and not yet taken up (a `withdrawn` event gives their texts); "" or why not. */
  withdraw(): string {
    return "no agent";
  }

  /** A side question about the session, answered apart from it (`aside` events) and kept out of its conversation; "" or why not. */
  sideQuestion(_question: string): string {
    return "no agent";
  }

  /** Write a line to the agent's process as it is (tests, a protocol's own messages). */
  write(_line: string): void {}

  /** Let the process end after its turn (killed past a grace period); kill it now. */
  stop(): void {}

  kill(): void {}
}
