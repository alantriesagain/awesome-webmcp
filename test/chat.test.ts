// ffi: @light/plugins/native/ffi.json
// The chat against recorded CLI traffic, read by Claude Code's plugin (plugins/claude/index.ts) into the
// conversation: each fixture's stdout lines received by the agent (and the messages the user sent,
// queued as the app queues them), the turns rendered at 80 columns and compared with
// test/golden/<fixture>.txt (UPDATE_GOLDEN=1 rewrites them). A transcript with a
// rewound branch and a compact boundary, resumed, keeps only the active branch. Calls made one
// after another are one line in the turn (one call: its tool and command, cut short); drawn on its
// own (a subagent's steps) a call is its line, and open, its command whole. Thinking that came with
// words is its first line, opened to all of them; thinking without words is not drawn. A
// 5000-delta stream reduces and re-renders in budget.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Conversation } from "../src/conversation/conversation.ts";
import { ChatModel, Item, TOOL, Turn } from "../src/conversation/model.ts";
import { itemLines, RenderContext, turnLines } from "../src/conversation/render.ts";
import { stamp } from "@light/ui/duration.ts";
import { findCall } from "../src/conversation/calls.ts";
import { openWorkspace } from "@light/workspace/workspace.ts";
import { createWidecode } from "../src/compose.ts";
import { Line } from "@lightstart/light/native/tui/lines.ts";
import { budget, done, eq, ok } from "@light/test/assert.ts";
import { contentText, projectDir, rec, str } from "./support/claude-records.ts";
import { registerLanguages } from "@lightstart/highlight/languages.ts";

registerLanguages();

const fixtures = join(process.cwd(), "test", "fixtures");
const golden = join(process.cwd(), "test", "golden");
const update = (process.env["UPDATE_GOLDEN"] ?? "") === "1";

interface Frame {
  dir?: unknown;
  raw?: unknown;
}

const textOf = (l: Line): string => {
  let s = "";
  for (const r of l.runs) s += r.text;
  return s.replace(/\s+$/, "");
};

const render = (model: ChatModel, folder: string): string => {
  const ctx = new RenderContext();
  ctx.folder = folder;
  ctx.agent = "Claude";
  // The goldens compare layout: the stamps carry a live time, so they are left off here (tested above).
  ctx.stamps = false;
  const out: string[] = [];
  for (const t of model.turns) for (const l of turnLines(t, ctx, 80)) out.push(textOf(l));
  for (const p of model.pending) out.push("queued: " + p.text);
  return out.join("\n") + "\n";
};

/** The folder the fixture's session ran in (its calls' paths are shown relative to it). */
const folderOf = (name: string): string => {
  const found = readFileSync(join(fixtures, name + ".ndjson"), "utf8").match(/"cwd\\?":\\?"(\/tmp\/code-probe-[A-Za-z0-9]+)/);
  return found !== null ? found[1] : "";
};

const main = async (): Promise<void> => {
  const folder = mkdtempSync(join(tmpdir(), "widecode-chat-"));
  const projects = join(folder, ".projects");
  const ws = await openWorkspace(folder, 100);
  const c = new Conversation(ws.folder);
  const config: unknown = { claude: { projects } };
  const w = createWidecode(ws, c, config);
  /** A record, as if the CLI wrote it. */
  const receive = (o: unknown): void => c.receive(JSON.stringify(o));
  /** The conversation started over: the model the next records go to. */
  const fresh = (): ChatModel => {
    c.reset();
    return c.model;
  };

  const replay = (name: string, expandTools: boolean): ChatModel => {
    const model = fresh();
    for (const line of readFileSync(join(fixtures, name + ".ndjson"), "utf8").split("\n")) {
      if (line.length === 0) continue;
      const f = JSON.parse(line) as Frame;
      const raw = str(f.raw);
      let value: unknown = null;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      const r = rec(value);
      if (r === null) continue;
      if (str(f.dir) === "in") {
        if (str(r.type) === "user") {
          const m = rec(r.message);
          const got = contentText(m !== null ? m.content : null);
          model.send(got.text, got.images);
        }
        continue;
      }
      c.receive(raw);
    }
    if (expandTools)
      for (const t of model.turns)
        for (const item of t.body.children)
          if (item.kind === TOOL) {
            item.expanded = true;
            model.touch(item);
          }
    return model;
  };

  const check = (name: string, expandTools: boolean): void => {
    const model = replay(name, expandTools);
    const text = render(model, folderOf(name));
    const file = join(golden, name + ".txt");
    if (update || !existsSync(file)) writeFileSync(file, text);
    eq(name + " renders as its golden file", text, readFileSync(file, "utf8"));
  };

  for (const name of ["turn", "edit", "interrupt", "subagent", "midturn", "midtool", "ask", "plan", "image", "compact"]) check(name, name === "edit");

  {
    const model = replay("midturn", false);
    eq("midturn: two turns, one per message, none left queued", String(model.turns.length) + ":" + String(model.pending.length), "2:0");
    const tool = replay("midtool", false);
    eq("midtool: a message sent while a tool ran opens a turn when the CLI takes it up, none left queued", String(tool.turns.length) + ":" + String(tool.pending.length), "2:0");
    const sub = replay("subagent", false);
    ok("subagent: the Agent call holds the subagent's items", sub.turns.length > 0 && sub.turns[0].body.children.some((i: Item) => i.kind === TOOL && i.name === "Agent" && i.children.length > 0));
    ok("subagent: a turn Claude started after the background task", sub.turns.some((t: Turn) => t.prompt === null));
  }

  {
    // Messages queued while Claude was busy, taken up by the CLI as one message (a text block each).
    const model = fresh();
    model.send("first", 0);
    receive({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: "first" }] } });
    for (const text of ["ok", "yes", "yes", "/context"]) model.send(text, 0);
    receive({ type: "user", isReplay: true, message: { role: "user", content: [{ type: "text", text: "ok" }, { type: "text", text: "yes" }] } });
    eq("messages sent together leave the queue together, a twin of one stays", model.pending.map((p) => p.text).join(","), "yes,/context");
    eq("and show as one prompt", model.turns[model.turns.length - 1].prompt?.text ?? "", "ok\nyes");
    receive({ type: "user", isReplay: true, message: { role: "user", content: "<local-command-stdout>Context: 12k</local-command-stdout>" } });
    eq("a command's output takes the queued command", model.pending.map((p) => p.text).join(","), "yes");
  }

  const note = (summary: string): string => "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>" + summary + "</summary>\n</task-notification>";
  {
    // A message sent while a tool ran, kept in the transcript as an attachment with content blocks.
    const saved = fresh();
    receive({ type: "user", message: { role: "user", content: "run it" } });
    receive({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "sleep 6" } }] } });
    receive({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] } });
    receive({ type: "attachment", attachment: { type: "queued_command", prompt: [{ type: "text", text: "also say BANANA" }] } });
    ok("a transcript's message sent while a tool ran is shown", render(saved, "").includes("› also say BANANA"));
    receive({ type: "attachment", attachment: { type: "queued_command", prompt: note('Background command "Wait" completed (exit code 0)'), commandMode: "task-notification" } });
    ok("a background task's notification, mid-turn, is one line too", render(saved, "").includes('◇ Background command "Wait" completed (exit code 0)') && !render(saved, "").includes("task-id"));
  }

  {
    // A message of several lines: a row each, none holding a newline (a row that did pushed the chat's last rows out of view).
    const lines = fresh();
    receive({ type: "user", message: { role: "user", content: "first line\nsecond line\n\nafter a gap" } });
    const at = 1773317580000; // 2026-03-12 12:13:00 UTC
    lines.turns[0].at = at;
    const shown = turnLines(lines.turns[0], new RenderContext(), 80);
    const lead = "[" + stamp(at) + "] <Me>: ";
    const pad = " ".repeat(lead.length);
    eq("a message's lines, a row each, under its label", shown.slice(0, 4).map(textOf).join("|"), lead + "first line|" + pad + "second line||" + pad + "after a gap");
    ok("no row holds a newline", shown.every((l: Line) => l.runs.every((r) => !r.text.includes("\n"))));
  }

  {
    // A background task's notification, Claude Code's own message: one line, and never taken for a message the user queued.
    const tasks = fresh();
    tasks.send("my question", 0);
    receive({ type: "user", isReplay: true, message: { role: "user", content: note('Background command "Run the gates" completed (exit code 0)') } });
    eq("the user's queued message stays queued", tasks.pending.map((p) => p.text).join(","), "my question");
    eq("the notification is one line", turnLines(tasks.turns[0], new RenderContext(), 80).map(textOf)[0], '◇ Background command "Run the gates" completed (exit code 0)');
  }

  {
    // What the views read about a call, from Claude's tool table: its kind, line, files, command, todos, a subagent's task; a question's questions.
    const facts = fresh();
    receive({ type: "system", subtype: "init", cwd: "/repo", session_id: "s-facts" });
    receive({ type: "user", message: { role: "user", content: "go" } });
    receive({
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test\nnpm run lint" } },
          { type: "tool_use", id: "e1", name: "Edit", input: { file_path: "/repo/src/a.ts", old_string: "a", new_string: "b" } },
          { type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [{ content: "write it", status: "completed" }, { content: "test it", status: "in_progress" }] } },
          { type: "tool_use", id: "g1", name: "Agent", input: { subagent_type: "Explore", description: "Find callers", prompt: "Find the callers of helper" } },
        ],
      },
    });
    receive({ type: "control_request", request_id: "q1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "a1", input: { questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "Red", description: "warm" }] }] } } });
    const call = (id: string): string => {
      const item = facts.tool(id);
      return item === null ? "" : [item.category, item.summary, item.paths.join(","), item.command.replace("\n", "/"), item.todos.map((t) => t.state + ":" + t.text).join(","), item.agentType + "|" + item.agentTask].join(" ; ");
    };
    eq("a run: its command whole", call("b1"), "run ; npm test … ;  ; npm test/npm run lint ;  ; |");
    eq("an edit: its file, relative in its line", call("e1"), "edit ; src/a.ts  +1 -1 ; /repo/src/a.ts ;  ;  ; |");
    eq("a todo list", call("t1"), "todo ; 2 todos ;  ;  ; done:write it,doing:test it ; |");
    eq("a subagent: its kind and task", call("g1"), "agent ; Explore: Find callers ;  ;  ;  ; Explore|Find callers");
    const asked = facts.openRequests()[0];
    eq("a question: its questions and choices", asked.category + " " + asked.questions.map((q) => q.question + " " + q.options.map((o) => o.label + "/" + o.description).join(",")).join(";"), "question Which? Red/warm");
  }

  {
    // The app's own notice while Claude is idle: after the last turn, no turn opened, nothing running.
    const idle = fresh();
    idle.notice("Commands: /help", "info", "", "");
    ok("before any message: a notice alone, no turn Claude started", idle.turns.length === 1 && !idle.running && render(idle, "") === "· Commands: /help\n\n");
    receive({ type: "user", message: { role: "user", content: "hi" } });
    receive({ type: "result", subtype: "success", duration_ms: 1200, total_cost_usd: 0.01 });
    idle.notice("This session's file changed 3 s ago", "info", "", "");
    const after = render(idle, "").split("\n");
    ok("after a turn: under its footer, the turn still closed", !idle.running && idle.turns.length === 2 && after.indexOf("· This session's file changed 3 s ago") > after.findIndex((l: string) => l.includes("✓ 1.2s")));
  }

  {
    // Two branches from the same prompt (the first rewound), then a compact boundary continuing the second: resumed from the session's file.
    const r = (o: unknown): string => JSON.stringify(o);
    const lines = [
      r({ type: "mode", mode: "normal" }),
      r({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "first prompt" } }),
      r({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", content: [{ type: "text", text: "first answer" }] }, apiBlockIndex: 0 }),
      r({ type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: "rewound prompt" } }),
      r({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { id: "m2", content: [{ type: "text", text: "rewound answer" }] }, apiBlockIndex: 0 }),
      r({ type: "user", uuid: "u3", parentUuid: "a1", message: { role: "user", content: "kept prompt" } }),
      r({ type: "assistant", uuid: "a3", parentUuid: "u3", message: { id: "m3", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] }, apiBlockIndex: 0 }),
      r({ type: "user", uuid: "r3", parentUuid: "a3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] }, toolUseResult: { stdout: "a.txt" } }),
      r({ type: "system", subtype: "compact_boundary", uuid: "c1", parentUuid: null, logicalParentUuid: "r3", compactMetadata: { trigger: "auto", preTokens: 979825, postTokens: 27159 } }),
      r({ type: "user", uuid: "s1", parentUuid: "c1", isCompactSummary: true, message: { role: "user", content: "Summary: listed files" } }),
      r({ type: "user", uuid: "u4", parentUuid: "s1", message: { role: "user", content: "after compact" } }),
      r({ type: "assistant", uuid: "a4", parentUuid: "u4", message: { id: "m4", content: [{ type: "text", text: "done" }] }, apiBlockIndex: 0 }),
      r({ type: "ai-title", aiTitle: "x" }),
    ];
    mkdirSync(projectDir(projects, folder), { recursive: true });
    writeFileSync(join(projectDir(projects, folder), "branches.jsonl"), lines.join("\n") + "\n");
    c.resume("branches", "");
    const model = c.model;
    const text = render(model, "");
    ok("the rewound branch is dropped", !text.includes("rewound"));
    ok("the kept branch and the compacted part are in order", text.indexOf("first prompt") < text.indexOf("kept prompt") && text.indexOf("kept prompt") < text.indexOf("Conversation compacted") && text.indexOf("Conversation compacted") < text.indexOf("after compact"));
    const ls = findCall(model, "t1");
    ok("the tool call got its result", text.includes("· Bash ls") && ls !== null && ls.result !== null && ls.result.text === "a.txt");
    ok("a transcript's compaction: how and how much", text.includes("· Conversation compacted automatically · 980k → 27k tokens"));
  }

  {
    const long = "for f in $(git ls-files 'src/**/*.ts'); do npx prettier --check \"$f\" || echo \"needs formatting: $f\"; done && echo all-checked";
    const calls = fresh();
    receive({ type: "user", uuid: "u1", message: { role: "user", content: "check formatting" } });
    receive({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "The user wants a check.\nI will loop over the files." }, { type: "thinking", thinking: "" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: long } }] } });
    const shown = render(calls, "");
    const head = shown.split("\n").find((l: string) => l.startsWith("· Bash for f in")) ?? "";
    ok("a long command is cut short on its turn's line", head.includes("…") && !head.includes("all-checked") && head.length < 80);
    const call = calls.turns[0].body.children[2];
    const card = (): string => itemLines(call, new RenderContext(), [], 80).map(textOf).join("\n");
    ok("drawn on its own, a call's line cuts it short too", card().startsWith("● Bash for f in") && !card().includes("all-checked"));
    eq("thinking with words is its first line; without words, nothing", shown.split("\n").filter((l: string) => l.startsWith("✻")).join("|"), "✻ The user wants a check. …");
    for (const item of calls.turns[0].body.children) {
      item.expanded = true;
      calls.touch(item);
    }
    const open = render(calls, "");
    ok("opened, the command shows whole, wrapped", card().includes("all-checked") && card().includes("needs formatting"));
    ok("and the thinking all its words", open.includes("I will loop over the files."));
  }

  {
    const model = fresh();
    const ctx = new RenderContext();
    const t0 = Date.now();
    model.send("go", 0);
    receive({ type: "user", isReplay: true, message: { role: "user", content: "go" } });
    receive({ type: "stream_event", event: { type: "message_start", message: { id: "msg1" } } });
    receive({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    let lines = 0;
    // As the CLI's output arrives: a batch at a time, here 16 lines, each drawn.
    let batch: string[] = [];
    for (let i = 0; i < 5000; i++) {
      batch.push('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"word' + String(i) + (i % 50 === 49 ? "\\n" : " ") + '"}}}');
      if (i % 16 !== 15 && i < 4999) continue;
      c.receive(batch.join("\n"));
      batch = [];
      lines = turnLines(model.turns[0], ctx, 100).length;
    }
    const ms = Date.now() - t0;
    ok("5000 deltas in batches of 16, reduced and re-rendered after each (" + String(lines > 100) + ")", lines > 100);
    ok("in budget (under 3 s)", ms < budget(3000));
  }

  w.host.kernel.stop();
  w.js.killProcesses();
  ws.close();
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
