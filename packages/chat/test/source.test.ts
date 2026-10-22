// The first queued message while a turn runs: shown under the transcript as queued, and the next
// ones after it, rather than being drawn as already sent.
import { ChatSource } from "../chat-pane.ts";
import { ChatHost } from "../host.ts";
import { ChatTarget, ToolsTarget } from "../roles.ts";
import { CodeTarget } from "@widecode/code/target.ts";
import { Conversation } from "@widecode/conversation/conversation.ts";
import { PromptHistory } from "@widecode/conversation/history.ts";
import { ScreenController } from "@widecode/screen/screen.ts";
import { Kernel } from "@light/kernel/kernel.ts";
import { done, eq } from "@light/test/assert.ts";

class FakeHost extends ChatHost {
  readonly conversation: Conversation;

  constructor() {
    super();
    this.conversation = new Conversation("/tmp/widecode-chat-source");
  }

  current(): Conversation {
    return this.conversation;
  }

  screen(): ScreenController {
    throw new Error("unused");
  }

  kernel(): Kernel {
    throw new Error("unused");
  }

  chat(): ChatTarget {
    throw new Error("unused");
  }

  tools(): ToolsTarget {
    throw new Error("unused");
  }

  code(): CodeTarget {
    throw new Error("unused");
  }

  paths(): string[] {
    return [];
  }

  history(): PromptHistory {
    throw new Error("unused");
  }

  openPath(_path: string): void {
    throw new Error("unused");
  }
}

const host = new FakeHost();
const source = new ChatSource(host);
host.conversation.model.running = true;
host.conversation.model.send("first queued", 0);
host.conversation.model.send("second queued", 0);
source.invalidate();
source.prepare(80);
const lines: string[] = [];
for (let i = 0; i < source.count(); i++) {
  const line = source.line(i, 80);
  if (line !== null) lines.push(line.runs.map((r) => r.text).join(""));
}
eq("the first queued message is queued, not sent", String(lines.filter((l) => l.includes("queued")).length), "2");
done();
