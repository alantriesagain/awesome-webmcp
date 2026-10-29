// The API widecode gives its JS plugins (the `widecode` global, defined by src/runtime/prelude.ts). A
// plugin is a .js file in ~/.widecode/plugins (or a trusted project's .widecode/plugins) that calls
// `widecode.plugin(...)`; for editor checking, start it with
//   /// <reference path="/path/to/widecode.d.ts" />
//   // @ts-check
// Values cross into the core as JSON, so what a plugin passes and keeps is plain data.

declare namespace widecode {
  /** A key as the core saw it: `spec` is modifiers then the key ("f5", "alt+down", "char:]"). */
  interface Key {
    spec: string;
    name: string;
    text: string;
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
  }

  /**
   * An action: what a key can do, named so a keymap can bind keys to it. Its scope is "" (anywhere),
   * a column ("chat" | "side" | "tools" | "code"), a tab id, or "input" (the composer); `key` is its
   * default key spec, or several. `run` gets the key and a count (1 unless a keymap plugin repeats it)
   * and answers true when it took the key.
   */
  interface ActionDef {
    id: string;
    scope?: string;
    help?: string;
    key?: string | string[];
    run(key: Key, count: number): boolean | void;
  }

  /** A keymap: by scope, a key spec ("ctrl+char:p", "*" for any key) to the action(s) it runs, or null to bind it to nothing. */
  type Keymap = Record<string, Record<string, string | string[] | null>>;

  interface Command {
    /** With its slash: "/hello". */
    name: string;
    /** What follows the name in /help ("<name>"). */
    usage?: string;
    help?: string;
    run(arg: string): void;
    /**
     * The values its argument can take given `arg`, what is typed so far, best first: the strip
     * above the composer lists them as the user types, ↑↓ choose, Enter runs the command with the
     * one chosen, Tab puts it in. A string is its own label.
     */
    complete?(arg: string): (string | { value: string; label?: string; detail?: string })[];
  }

  /** The hooks a plugin can listen to; a listener gets nothing and reads what changed. */
  type Hook = "conversationChanged" | "sessionsChanged" | "filesLoaded" | "statusLoaded" | "folderChanged" | "folderOpened" | "baseChanged" | "fileShown" | "messageSending" | "keymapChanged" | "messageChanged" | "toolsChanged" | "harnessChanged";

  /** A piece of a row in one style; colors are "#rrggbb", "0"…"255" or a name ("gray", "cyan"). */
  interface Run {
    text: string;
    fg?: string;
    bg?: string;
    bold?: boolean;
    dim?: boolean;
    italic?: boolean;
    underline?: boolean;
    /**
     * "spinner": the host draws the spinner's current frame in place of `text` and moves it on its
     * own, so a plugin refreshes for its clocks, not for the spinner; `text` stands in for its width.
     */
    live?: "spinner";
  }

  /** A row: a plain string, or runs on a background. */
  type Row = string | { bg?: string; runs: Run[] };

  interface Panel {
    /** Its id: its keys' scope, and what refresh and showPanel name. */
    id: string;
    title?: string;
    /** Left to right among its column's tabs (the files column's built-in ones are 0, 1, 2; the tools column's Tools tab 0). */
    order?: number;
    /** The tab column it shows in: "side" (default), the files column; "tools", the column beside the chat. */
    column?: "side" | "tools";
    count(): number;
    /** Rows `from` to `from + count - 1` at `width` cells (fewer at the end). */
    rows(from: number, count: number, width: number): Row[];
    /** The row under the tabs. */
    info?(): Run[];
    /** Its column's width while it shows, at `cols` terminal columns. */
    width?(cols: number): number;
    press?(row: number, x: number): void;
    infoPress?(x: number): void;
    shown?(): void;
    /** Another tab of its column took its place. */
    hidden?(): void;
    /** What the tab's link on the band shows after its title (a count, ahead and behind). */
    badge?(): Run[];
  }

  interface Band {
    id: string;
    /** The column it sits under, as wide as it: "chat", "tools", "side" or "code"; "" (default): the last one. */
    under?: string;
    order?: number;
    lines(width: number): Row[];
    press?(row: number, x: number): void;
  }

  /** Claude Code's status line input, with widecode's extras under `widecode`. */
  interface StatusInfo {
    cwd: string;
    session_id: string;
    session_name: string;
    transcript_path: string;
    model: { id: string; display_name: string };
    workspace: { current_dir: string; project_dir: string; added_dirs: string[] };
    version: string;
    output_style: { name: string };
    cost: { total_cost_usd: number; total_duration_ms: number; total_api_duration_ms: number; total_lines_added: number; total_lines_removed: number };
    context_window: {
      total_input_tokens: number;
      total_output_tokens: number;
      context_window_size: number;
      used_percentage: number;
      remaining_percentage: number;
      current_usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number };
    };
    exceeds_200k_tokens: boolean;
    prompt_cache: { warm: boolean; caching_observed: boolean; ttl: string; expires_at: number; requests: number; misses: number; hit_ratio: number };
    effort: { level: string };
    rate_limits: { five_hour: { used_percentage: number; resets_at: number }; seven_day: { used_percentage: number; resets_at: number } };
    widecode: { branch: string; mode: string; activity: string; activity_ms: number; queued: number; reads: number; writes: number; execs: number; agents: number; calls: number; thinking_tokens: number };
  }

  /** What a status segment draws from. */
  interface SegmentContext {
    /** Claude Code's status line input (model, context_window, rate_limits, cost, ...). */
    info: StatusInfo;
    folderName: string;
    /** The latest message, or the key hints. */
    note: string;
    busy: boolean;
    spinner: string;
    now: number;
  }

  interface Segment {
    /** The name config.json's status lines use. */
    name: string;
    draw(ctx: SegmentContext): Run[];
    press?(): void;
  }

  /** Drawn things a plugin refreshes when its data changed. */
  interface Drawn {
    refresh(): void;
  }

  /** A process a plugin keeps running (api.process.spawn). */
  interface ProcessHandle {
    /** Whether it started (else `error` heard why). */
    started: boolean;
    /** Write `line` and a newline to its input; false when it has ended. */
    write(line: string): boolean;
    stop(graceMs?: number): void;
    kill(): void;
  }

  /** The status fields an agent fills (Claude Code's status line input, conversation/status-info.ts): context in tokens, rate limits in percent with resets in epoch seconds, times in epoch ms. */
  interface StatusFields {
    sessionId: string;
    transcriptPath: string;
    cwd: string;
    version: string;
    modelId: string;
    knownWindow: number;
    mode: string;
    contextInput: number;
    contextOutput: number;
    contextCacheRead: number;
    contextCacheWrite: number;
    contextSize: number;
    totalInput: number;
    totalOutput: number;
    fiveHourPct: number;
    fiveHourResets: number;
    weekPct: number;
    weekResets: number;
    requests: number;
    misses: number;
    cacheRead: number;
    allInput: number;
    cacheTtlMs: number;
    lastRequestMs: number;
    costUsd: number;
    startMs: number;
    apiMs: number;
    linesAdded: number;
    linesRemoved: number;
    thinking: number;
  }

  /** A value the agent lets the user choose (a model, an effort, a mode), and its name on the screen. */
  interface AgentOption {
    value: string;
    name: string;
  }

  /** A session as an agent lists it. */
  interface AgentSession {
    id: string;
    title?: string;
    firstPrompt?: string;
    /** The last prompt the user sent, the folder it ran in and the model that answered last, when the agent knows them. */
    lastPrompt?: string;
    cwd?: string;
    model?: string;
    mtimeMs?: number;
    size?: number;
  }

  /** What `start` gets: the folder, the model, effort and session to resume chosen, and the command and flags the user set ("" and [] for the agent's own). */
  interface AgentStart {
    cwd: string;
    model: string;
    effort: string;
    resume: string;
    executable: string;
    /** What the agent's system prompt gets appended: the harness's fixed paragraph and the project's prompt.md ("" for nothing). */
    systemPrompt: string;
    /** Tool permission rules in Claude Code's syntax: the user's, with the trusted project's ask and deny rules added (every list empty for none). */
    permissions: { allow: string[]; ask: string[]; deny: string[] };
    args: string[];
  }

  /**
   * One of widecode's own tools: its name (an agent prefixes it with the server's: opencode's
   * `widecode_AskUser`), what it does, its input's JSON schema, and what kind of call it is, as the
   * views draw it ("question" and "plan" show as their request, not as a call).
   */
  interface Tool {
    name: string;
    description?: string;
    input?: unknown;
    category?: string;
    /** The agent plugins whose agents do not see it: those with a tool of their own for the need (`["claude"]` for a question, which Claude Code asks with AskUserQuestion). */
    except?: string[];
    /** A call with its arguments: answers text (a value that is not is sent as JSON), now or as a promise; an error thrown is the call's error. */
    call(args: Record<string, unknown>): unknown;
  }

  /** A request for the user, as `respond` gets it, and the user's reply. */
  interface AgentRequest {
    id: string;
    category: string;
    name: string;
    callId: string;
  }
  interface AgentReply {
    /** "answered" (answers), "approved" (a plan), "declined" (message says why), "cancelled" (a tool's request went away). */
    state: string;
    answers: { question: string; labels: string[]; text: string }[];
    message: string;
  }

  /**
   * An agent behind the conversation: its functions do what the user asks, and it hands its agent's
   * messages to the conversation as events (api.conversation.apply). `start` starts its process (a
   * `process` event with state "running" says it runs, "ended" that it stopped); `send` writes a
   * message (the conversation has queued it; a `take` event says the agent took it up). Each answers
   * "" or why it could not.
   */
  interface AgentAdapter {
    /** Its id in config.json and `--agent`, and its name as the screen says it. */
    id: string;
    name?: string;
    /** What it offers from the start (a `choices` event changes it); `anyModel` when it takes any model name it is given (Claude Code's aliases). */
    choices?: { anyModel?: boolean; models?: AgentOption[]; efforts?: AgentOption[]; modes?: AgentOption[] };
    /** Start at launch, after /new and in a folder opened, not on the first message: an agent whose models and efforts come with its session. */
    eager?: boolean;
    start(options: AgentStart): string | void;
    send(text: string, images: { mediaType: string; data: string; path?: string }[]): string | void;
    interrupt?(): void;
    setMode?(mode: string): string | void;
    setModel?(name: string): void;
    setEffort?(level: string): void;
    respond?(request: AgentRequest, reply: AgentReply): void;
    /** Show session `id` (events), and resume it on the next start. */
    resume?(id: string): void;
    /** Forget the session (a new one starts on the next message). */
    reset?(): void;
    /** Read the part of the session before the part shown, and apply all of it again (the conversation's model is a new one); false when there is none. */
    loadEarlier?(): boolean;
    /** Read what the subagent call `callId` ran into the call; false when it is not kept. */
    loadSubagent?(callId: string): boolean;
    /** A line as if its process had written it (tests, replays), or a batch of them separated by newlines. */
    receive?(lines: string): void;
    /** Take back the messages queued and not yet taken up (↑ in an empty composer): a `withdrawn` event gives their texts, [] when none could be. */
    withdraw?(): string | void;
    /** A side question about the session (/btw): `aside` events show it and its answer, which stay out of the conversation. */
    sideQuestion?(question: string): string | void;
    stop?(): void;
    kill?(): void;
    /** Its sessions in `folder`, newest first, as it knows them now (a `sessions` event says the list changed). */
    sessions?(folder: string): AgentSession[];
  }

  /**
   * A tool the agent has, in a `tools` event: its name, the MCP server it comes from (none for the
   * agent's own), the name its calls carry when it is another (`id`: Claude Code's
   * mcp__<server>__<tool>; a call says it in its `tool` fact or its name), and what the mode lets
   * it do: `access` "asks" (each call asks the user), "limited" (only what `scope` names), "denied"
   * (the agent does not offer it), anything else when left out.
   */
  interface AgentTool {
    name: string;
    server?: string;
    id?: string;
    access?: "asks" | "limited" | "denied";
    scope?: string;
  }

  /**
   * A skill the agent has, in a `skills` event: its name, what it is for, where it comes from
   * ("project", "user", a plugin's name, "built-in"), its file ("" for one built into the agent) and
   * the text that calls it from the composer ("/name" for Claude Code; "" for an agent whose skills
   * are asked for in words).
   */
  interface AgentSkill {
    name: string;
    description?: string;
    source?: string;
    path?: string;
    command?: string;
  }

  /** What the views know about a call: its kind (read, edit, run, search, fetch, agent, todo, skill, other), its one line (a skill call's: the skill's name), the files it touches, a command whole, what it wrote, a todo list, a subagent's kind, task and prompt. */
  interface CallFacts {
    category?: string;
    /** The tool it is of, as the agent's list of tools names it, when the call's name is another. */
    tool?: string;
    summary?: string;
    paths?: string[];
    command?: string;
    written?: string;
    todos?: { text: string; state: "done" | "doing" | "todo" }[];
    agentType?: string;
    agentTask?: string;
    agentPrompt?: string;
  }

  /**
   * A change to the conversation (conversation/events.ts). A block is named by `parent` (the call it
   * is under, "" for the turn) and the adapter's own `key`; a call by its `id`. A batch happens when
   * it is applied, unless an `at` event says when (epoch ms: a transcript's own times).
   */
  type ConversationEvent =
    | { type: "at"; ms: number }
    | { type: "process"; state: "running" | "ended" }
    | { type: "sessions" }
    | { type: "choices"; anyModel?: boolean; models?: { value: string; name?: string }[]; efforts?: { value: string; name?: string }[]; modes?: { value: string; name?: string }[] }
    | { type: "session"; id?: string; model?: string; cwd?: string; mode?: string; effort?: string; commands?: string[]; earlier?: boolean }
    /** The queued messages the agent took back, for the composer ([] when it was too late for all of them). */
    | { type: "withdrawn"; texts: string[] }
    /** Side question `id`: its question (when new), its answer so far or whole (`done`), or why it failed. */
    | { type: "aside"; id: string; question?: string; text?: string; done?: boolean; error?: string }
    /** The tools the agent has now (each with its MCP server's name, "" for its own) and its MCP servers; `partial` when it lists none of its own. */
    | { type: "tools"; tools: AgentTool[]; servers?: { name: string; status?: string }[]; partial?: boolean }
    /** The skills the agent has now; `partial` while the list is what its plugin found on disk before the agent said (the agent's own come with its start). */
    | { type: "skills"; skills: AgentSkill[]; partial?: boolean }
    | { type: "mode"; mode: string }
    | { type: "status"; status: string }
    | { type: "take"; text: string; parts?: string[] }
    | { type: "takeCommand" }
    | { type: "turn"; text?: string; images?: number; imagePaths?: string[]; prompt?: boolean; notice?: boolean }
    | { type: "ensureTurn" }
    | { type: "startQueued" }
    | { type: "dropQueued" }
    | { type: "closeChildren"; id: string }
    | { type: "info"; fields: Partial<StatusFields> }
    | { type: "close" }
    | { type: "end"; error?: boolean; status?: string; reason?: string; durationMs?: number; costUsd?: number; text?: string }
    | ({ type: "block"; parent?: string; key: string; kind: "text" | "thinking" | "tool"; id?: string; name?: string; text?: string } & CallFacts)
    | { type: "text"; parent?: string; key: string; delta?: string; text?: string }
    | { type: "partial"; parent?: string; key: string; json: string }
    | { type: "input"; parent?: string; key: string; input: unknown; name?: string }
    | ({ type: "facts"; id: string } & CallFacts)
    | { type: "finish"; parent?: string; key: string }
    | { type: "result"; id: string; text?: string; images?: number; error?: boolean; patch?: { oldStart: number; newStart: number; lines: string[] }[] }
    | { type: "edited"; path: string }
    | { type: "prompt"; parent?: string; text: string; images?: number; imagePaths?: string[]; notice?: boolean }
    | { type: "notice"; text: string; tone?: "info" | "error" | "command"; detail?: string; parent?: string; once?: boolean; ifOpen?: boolean }
    | { type: "task"; id: string; taskId?: string; description?: string; agentType?: string; background?: boolean }
    | { type: "taskUpdate"; id: string; taskId?: string; status?: string; lastTool?: string; description?: string; summary?: string; done?: boolean }
    | { type: "thinkingTokens"; parent?: string; key: string; tokens: number }
    | { type: "request"; id: string; name?: string; callId?: string; input?: unknown; category: "question" | "plan" | "permission"; questions?: { question: string; header?: string; multi?: boolean; options: { label: string; description?: string }[] }[]; plan?: string }
    /** Request `id` is no longer open: withdrawn by the agent, or `answered` without the panel (an answer the user gave before covers it). */
    | { type: "cancelRequest"; id: string; state?: "answered" }
    | { type: "usage"; model?: string; version?: string; contextUsed?: number; contextSize?: number; costUsd?: number; inputTokens?: number; outputTokens?: number };

  /** A view in the code column, as its plugin drives it. */
  interface CodeViewHandle {
    show(title?: string): void;
    refresh(): void;
    shown(): boolean;
  }

  /** A side tab, as its plugin drives it. */
  interface PanelHandle extends Drawn {
    /** Scroll the tab so row `row` shows. */
    reveal(row: number): void;
  }

  /** One of the folder's sessions with the agent. */
  interface SessionSummary {
    id: string;
    /** The agent's own title for it ("" for none). */
    agentTitle: string;
    firstPrompt: string;
    /** The last prompt sent, the folder it ran in and the model that answered last ("" when the agent does not say). */
    lastPrompt: string;
    cwd: string;
    model: string;
    /** When it was last written (epoch ms), and its size in bytes (0 when the agent does not say). */
    mtimeMs: number;
    size: number;
    /** The title widecode keeps for it ("" for none), and who gave it: "claude" or "user". */
    storedTitle: string;
    titleBy: string;
  }

  /** What widecode keeps for a session in the project's .widecode/. */
  interface SessionRecord {
    title: string;
    /** "claude" or "user". */
    titleBy: string;
    /** The commit HEAD was on when the session started ("" before its first turn). */
    baseCommit: string;
    /** The file the code column last showed in it (folder-relative; "" for none). */
    file: string;
    /** What the session cost across the agent's processes, its thinking tokens, the model and effort it ran on, its context window (0: not seen). */
    costUsd: number;
    thinkingTokens: number;
    model: string;
    effort: string;
    contextWindow: number;
    /** The agent the session belongs to ("claude", or a plugin agent's id); "" in a record from before it was kept. */
    agent: string;
  }

  /** A subagent the session called. */
  interface Agent {
    /** Its call's tool use id (what openAgent takes). */
    id: string;
    /** Its kind (subagent_type) and the task it was given. */
    type: string;
    description: string;
    status: "running" | "done" | "failed" | "interrupted";
    /** The tool it is using now (while it runs), and what it reported or handed back. */
    lastTool: string;
    summary: string;
    /** How many steps of it the session holds. */
    steps: number;
  }

  /** A file changed against the compare base. */
  interface Change {
    /** Relative to the folder. */
    path: string;
    /** The git mark: M, A, D, R, U (untracked) or ! (conflict). */
    mark: string;
    added: number;
    removed: number;
    /** Git cannot count its lines. */
    binary: boolean;
    /** When it last changed (epoch ms; 0 when unknown, a deleted file). */
    changedMs: number;
    /** The agent edited it in this session. */
    byAgent: boolean;
  }

  interface Commit {
    sha: string;
    short: string;
    subject: string;
    parents: string[];
    /** When it was committed (epoch ms), and by whom. */
    timeMs?: number;
    author?: string;
  }

  interface Branch {
    name: string;
    /** Its upstream ("origin/main"; "" for none), how far ahead and behind it, and whether it is gone from the remote. */
    upstream: string;
    ahead: number;
    behind: number;
    gone: boolean;
    current: boolean;
    /** The last commit's time (epoch ms) and subject. */
    commitMs: number;
    subject: string;
  }

  /** A row of the folder's tree. */
  interface TreeRow {
    path: string;
    name: string;
    depth: number;
    dir: boolean;
    open: boolean;
    /** The file's git mark, "•" for a folder holding changes, "" for none. */
    mark: string;
  }

  /** A file a commit changed. */
  interface CommitFile {
    path: string;
    /** A, M, D (T and others as git says). */
    mark: string;
    added: number;
    removed: number;
    binary: boolean;
  }

  interface Api {
    /** The plugin's id. */
    readonly id: string;
    commands: {
      add(command: Command): void;
      /** Run any registered command ("/files changed"); false when none has that name. */
      run(text: string): boolean;
      /** Drop this plugin's command `name` (one it replaced comes back); false when the plugin has none of that name. */
      remove(name: string): boolean;
    };
    keys: {
      /**
       * Bind `spec` in `scope` ("" anywhere, a column "chat" | "side" | "tools" | "code", or a tab
       * id); `hint` shows in the status bar while the scope is active; `run` answers true when it
       * took the key. A spec of "" is a hint alone. The key is an action named `<plugin>:<spec>`;
       * an action with a name of its own is `action`.
       */
      add(spec: string, scope: string, hint: string, run?: (key: Key, count: number) => boolean): void;
      /**
       * A keymap layer: its entries come before the actions' default keys (and a plugin's later
       * layer before an earlier one; the user's keys.json before all) while it is on, which it is
       * from the start. A vi mode is a layer turned on and off.
       */
      layer(id: string, table: Keymap): { on(): void; off(): void };
      /** Add an action; a later one of the same id replaces the earlier (a plugin can replace the core's). */
      action(action: ActionDef): void;
      /** Run action `id` by name, `count` times over (1 by default), as a key would; false when there is none or it did not take it. */
      run(id: string, count?: number): boolean;
      /**
       * A keymap the plugin brings, for /keymap (and config.json's "keymap"): the plugin turns its
       * layers on when `state.keymap()` names it, at activate and on the `keymapChanged` hook.
       */
      keymap(keymap: { id: string; name?: string }): void;
    };
    /** The chat's composer, for a keymap plugin that edits it (a vi mode). */
    composer: {
      /** Its lines and caret (`col` counts graphemes, `widecode.util.graphemes`), whether it is empty, and whether the suggestion strip shows or the request panel is open (their keys come first then). */
      get(): { lines: string[]; row: number; col: number; empty: boolean; strip: boolean; panel: boolean };
      /** Its lines and caret (clamped); completion follows as after a key. */
      set(lines: string[], row: number, col: number): void;
      insert(text: string): void;
      /** The composer's border title ("You"): a mode indicator. */
      setLabel(text: string): void;
    };
    on(hook: Hook, listener: () => void): void;
    /** A message in the status bar for a while (and the log). */
    tell(text: string): void;
    /** A line in the log. */
    note(text: string): void;
    ui: {
      panel(panel: Panel): PanelHandle;
      band(band: Band): Drawn;
      segment(segment: Segment): void;
      /** A notice in the chat, as /help answers: `text` shown, `detail` when it is opened. */
      notice(text: string, detail?: string): void;
      /** Draw a segment any plugin added (null when none has the name). */
      drawSegment(name: string, ctx: SegmentContext): Run[] | null;
      /** Press a segment any plugin added; false when it has no press. */
      pressSegment(name: string): boolean;
    };
    process: {
      /** Run `command` under `sh -c` with `input` on its stdin, killed past `timeoutMs` (2 s by default). */
      run(command: string, input?: string, timeoutMs?: number): Promise<{ code: number; out: string; err: string; timedOut: boolean }>;
      /**
       * Start `command` (the program, then its arguments) and keep it running: its output reaches
       * `lines` in batches, its end `exit`, what it writes to stderr (or why it did not start) `error`.
       * It ends with stop (its input closed, killed after `graceMs`), kill, or when the plugins load again.
       */
      spawn(command: string[], options?: { cwd?: string }, handlers?: { lines?(lines: string[]): void; exit?(code: number): void; error?(text: string): void }): ProcessHandle;
    };
    /** An agent the conversation can talk to (chosen with "agent" in config.json or `--agent`). */
    agents: {
      register(agent: AgentAdapter): void;
    };
    /** Files, read and never written (an agent's transcripts and session lists, a plan it wrote); paths absolute, answered at once. */
    fs: {
      /** The user's home folder, and an environment variable ("" when unset). */
      home(): string;
      env(name: string): string;
      /** The path of the running widecode (what a new terminal runs to open a session). */
      executable(): string;
      /** A folder's entries, by name, with their size and when they changed; [] when it cannot be read. */
      list(dir: string): { name: string; file: boolean; size: number; mtimeMs: number }[];
      /** A file's size and when it changed; null when there is none. */
      stat(path: string): { size: number; mtimeMs: number } | null;
      /** `length` bytes from `start`, as text ("" when it cannot be read). */
      read(path: string, start: number, length: number): string;
      /** A whole file as text (8 MB at most); null when it cannot be read. */
      text(path: string): string | null;
      /**
       * The lines that end before byte `before` (-1: the file's end, leaving out a line still being
       * written), in a window of about `maxBytes` that starts at a line (grown when one line is
       * longer), lines starting with a prefix in `skip` left out. `start` 0: nothing is before it.
       */
      window(path: string, before?: number, maxBytes?: number, skip?: string[]): { lines: string[]; start: number; end: number; size: number };
    };
    /** The conversation as an agent's adapter changes it. */
    conversation: {
      /** Apply events (one, or a list: one call per batch of the agent's messages); answers how many applied. */
      apply(events: ConversationEvent | ConversationEvent[]): number;
      /**
       * Put a request to the user for one of widecode's own tools (a request event's fields, without
       * its type and id): the panel shows it, and the reply comes here, not to the agent. Its state is
       * "cancelled" when the request went away first (its turn ended, the chat was cleared).
       */
      ask(request: { category: "question" | "plan"; name?: string; questions?: { question: string; header?: string; multi?: boolean; options: { label: string; description?: string }[] }[]; plan?: string }): Promise<AgentReply>;
    };
    /**
     * widecode's own tools, which agents call over MCP (widecode's server listens on 127.0.0.1; each
     * agent's plugin has a token of its own). An agent's plugin offers the server to its agent, which
     * sees the tools not excepted for that plugin; a tool an agent has its own for is excepted (Claude
     * Code keeps AskUserQuestion and ExitPlanMode).
     */
    tools: {
      add(tool: Tool): void;
      /** Where the server listens, the headers that let this plugin's agent in, the tools it sees and a config file naming the server (Claude Code's --mcp-config shape, readable by the user alone; "" when it could not be written), once it listens; null with no tools for it, or when it cannot listen. */
      server(): Promise<{ url: string; headers: { name: string; value: string }[]; tools: { name: string; category: string }[]; file: string } | null>;
    };
    /** Call `run` every `ms` while the plugin runs. */
    every(ms: number, run: () => void): void;
    /** Call `run` once, `ms` from now, if the plugin still runs. */
    after(ms: number, run: () => void): void;
    state: {
      /** The branch, and the git marks and lines changed ([added, removed, binary]) by path, against the compare base. */
      folder(): { branch: string; repo: boolean; truncated: boolean; marks: Record<string, string>; counts: Record<string, [number, number, boolean]> };
      /** Every file of the folder. */
      paths(): string[];
      /** The changed files, newest first (the watcher's batches and Claude's edits give the times, a file's mtime before either). */
      changes(): Change[];
      /** The side tabs' ids, left to right. */
      panels(): string[];
      /** The watcher's latest batch, for folderChanged listeners: what changed, whether files came or went, whether git's own files changed. */
      batch(): { paths: string[]; structure: boolean; git: boolean };
      base(): { base: string; kind: string; name: string };
      /** The active column; the tab it shows when it is a tab column, else the files column's; the folder. */
      active(): { column: string; panel: string; folder: string; folderName: string };
      /** Claude Code's status line input for the session. */
      info(): StatusInfo;
      /** The status bar's message, or the key hints when there is none. */
      note(): string;
      /** The keymap in use: "default", or the id a plugin's brought. */
      keymap(): string;
      /** The screen as drawn: the named columns (every column for []) each cropped to its cells, the band under them included; refused where nothing draws. */
      screen(columns: string[]): string;
      /** The last `n` lines of the log (every kept line for 0, 300 at most): notes, the status bar's messages, plugin errors. */
      log(n: number): string[];
      /** Every command, by name, with the plugin that added it. */
      commands(): { name: string; usage: string; help: string; owner: string }[];
      /** The columns left to right, and which is active. */
      columns(): { id: string; title: string; active: boolean }[];
    };
    /** The plugins as the runtime holds them, for the harness plugin: what runs and what failed, a file reloaded, a source checked before it is saved, the API's own documents. */
    plugins: {
      /** Every plugin registered, built-in first, with its file and state, and the last errors loading or running plugins. */
      list(): { plugins: PluginInfo[]; errors: string[] };
      /** Evaluate `file` again once the running call returns (a plugin folder's file, relative to the project folder or absolute; "" for every plugin, which restarts the agent on its session). "" when taken, else why not. */
      reload(file: string): string;
      /** Evaluate `code` (named `file` in its messages) in a context of its own, nothing registered: what it would define, its errors and warnings. */
      check(code: string, file: string): PluginCheck;
      /** The plugin guide (PLUGINS.md) and the API's types (widecode.d.ts), as the binary carries them. */
      api(): { guide: string; types: string };
    };
    /** The project's harness folder, `.widecode/` (PLUGINS.md, "The harness"). */
    harness: {
      info(): HarnessInfo;
      /** Write the folder's harness skeleton where a file is missing (prompt.md, plugins/example.js, config.json, Claude Code's skill for widecode): the paths written. */
      init(): string[];
    };
    actions: {
      focus(column: string): void;
      showPanel(panel: string): void;
      quit(): void;
      openFolder(path: string): void;
      /** Read the file list again. */
      loadFiles(): Promise<void>;
      /** Read git status and the line counts again. */
      loadStatus(): Promise<void>;
      setBase(base: string, kind: string, name: string): void;
      /** A path Claude named, relative to the folder ("" outside it). */
      relative(path: string): string;
    };
    code: {
      open(path: string): void;
      openCommit(commit: Commit, path: string, mark?: string): void;
      path(): string;
      inCommit(): boolean;
      /** Where the view is among the file's changes ("change 2/5 · L40"). */
      position(): string;
      /** Show the steps of the subagent called by tool use `id` in place of the file (Esc goes back). */
      openAgent(id: string): void;
      /** Show tool call `id` whole in place of the file: its input and output (a subagent's call: its steps). Esc goes back. */
      openCall(id: string): void;
      /** Whether it shows a subagent's steps or a call rather than a file. */
      inAgent(): boolean;
      /**
       * A view of this plugin's own rows for the code column, drawn as a tab's are (`count`, `rows`,
       * a `press` on a row); `show(title)` puts it in place of the file (Esc goes back), `refresh()`
       * redraws it while it shows, `shown()` says whether it does.
       */
      view(view: { id: string; count(): number; rows(from: number, count: number, width: number): Row[]; press?(row: number): void }): CodeViewHandle;
      /** Show `text` in place of the file, rendered as the chat renders markdown, under `title` (Esc goes back). */
      markdown(title: string, text: string): void;
      /** Scroll by `rows` (negative: up), to the top, to the end. */
      scroll(rows: number): void;
      toTop(): void;
      toEnd(): void;
      /** To the next (1) or previous (-1) change, wrapping around. */
      moveHunk(direction: number): void;
      /** Long lines wrapped onto the rows below. */
      wrap(): boolean;
      setWrap(on: boolean): void;
    };
    /** The system clipboard (OSC 52, or xclip/xsel/wl-copy where the terminal does not take it; config.json's "clipboard"). */
    clipboard: {
      /** Put `text` on it; "" when it went, else why not (also said in the status bar). */
      copy(text: string): string;
    };
    /** The core's own widgets, mounted as columns by the plugin that owns their role. */
    widgets: {
      /**
       * The chat widget as this plugin's column, `width(cols)` cells wide (half the terminal by
       * default); it plays api.chat's role. Claude's open question or plan takes a line from the
       * composer, else `onLine` gets it.
       */
      chat(column: { title?: string; order?: number; width?(cols: number): number; onLine?(text: string): void }): void;
      /** The code widget as this plugin's column; it plays api.code's role for every plugin. `onWrap` hears its wrap switch. */
      code(column: { title?: string; order?: number; onWrap?(wrap: boolean): void }): void;
      /** The Tools tab (Claude's tool calls, each with its clock) as this plugin's tab of the tools column, at `order` among its tabs. */
      tools(tab: { title?: string; order?: number }): void;
    };
    chat: {
      /** Send as the user would from the composer (commands included). */
      submit(text: string): void;
      /** Show the conversation from its end. */
      showChat(): void;
      /** Load the conversation's earlier part (it is read from its end). */
      loadEarlier(): void;
      toTop(): void;
      toEnd(): void;
    };
    /** The languages the code column and the chat's code blocks color. */
    languages: {
      /**
       * Color files with these extensions, and Markdown fences with these names, with one of the
       * core's tokenizers: "javascript", "typescript", "css", "html" or "markdown". A later language
       * with the same id replaces the earlier; a plugin's languages go when it stops.
       */
      add(language: { id: string; extensions?: string[]; fences?: string[]; tokenizer: string }): void;
    };
    files: {
      /**
       * The folder's tree as rows: folders first, then files, each sorted by name, a folder's
       * children shown when it is in `expanded`; with `changedOnly`, only the changed files and the
       * folders leading to them, all open. With the number of files (`truncated` past the limit)
       * and of changed ones.
       */
      tree(expanded: string[], changedOnly: boolean): { rows: TreeRow[]; total: number; truncated: boolean; changed: number };
    };
    /** Reading the folder's repository (never writing it). */
    git: {
      /** The local branches, the current one and the most recently committed first. */
      branches(): Promise<Branch[]>;
      /** Up to `max` of `ref`'s commits that touch the folder, newest first. */
      log(ref: string, max?: number): Promise<Required<Commit>[]>;
      commitFiles(commit: Commit): Promise<CommitFile[]>;
      /** origin's HEAD, else main, else master ("" for none). */
      defaultBranch(): Promise<string>;
      /** Where HEAD and `ref` last shared a commit ("" for none). */
      mergeBase(ref: string): Promise<string>;
      head(): Promise<string>;
      /** The commit HEAD's history was on at `ms` (epoch ms; "" for none). */
      commitAt(ms: number): Promise<string>;
      /** How many commits `a` has that `b` lacks and the reverse (-1 and -1 when either ref is unknown). */
      aheadBehind(a: string, b: string): Promise<{ ahead: number; behind: number }>;
      /** The repository's oldest root commit, what the same repository is called on another machine ("" without one). */
      rootCommit(): Promise<string>;
      /** The branches of `remote` as fetched here, each against the local branch of its name (`ahead` and `behind` -1 without one). */
      remoteBranches(remote: string): Promise<{ name: string; ref: string; sha: string; commitMs: number; local: boolean; ahead: number; behind: number }[]>;
    };
    /** The LAN git bridge (the peers plugin): this machine's daemon, started when needed; the daemon keeps every shared checkout fetched from each peer. */
    peers: {
      /**
       * A daemon answering: the one running, or one the real app starts now (`widecode --peers-daemon`)
       * when the bridge is in use here (a peer paired, a repository shared) or `start` asks for it; false
       * when none answers. A test or another program hosting the app never starts one.
       */
      ensure(start?: boolean): Promise<boolean>;
      /** `method` `path` on the daemon's control API, `body` sent as JSON: the status (0 when nothing answered) and the text. */
      request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }>;
      /** Share this folder's repository (at its root) with the paired peers, live: the share's key, or why not. */
      share(): Promise<{ key: string; error: string }>;
      /** Clone peer `peerId`'s offer at `key` to `path` (beside this folder as `name` when ""), shared live here once cloned: where it went, or why not. */
      clone(peerId: string, key: string, name: string, path?: string): Promise<{ path: string; error: string }>;
      /** The paired peers that have a remote named after them in this folder's repository, and whether each was seen in the last minutes. */
      remotes(): Promise<{ id: string; name: string; remote: string; online: boolean; lastSeenMs: number }[]>;
    };
    sessions: {
      /** The folder's sessions with the agent, newest first. */
      list(): SessionSummary[];
      /** Moves when the agent said its list changed. */
      rev(): number;
    };
    /** widecode's own records (none with --ephemeral). */
    store: {
      session(id: string): SessionRecord | null;
      /** Keep `fields` for session `id`; false when there is no store. */
      updateSession(id: string, fields: Partial<SessionRecord>): boolean;
      /** Keep a skill run that ended in the folder's records (by the chosen agent's session and the run's call, or a typed run's start, so keeping it again writes over it); false when there is no store or session. */
      saveSkillRun(run: { skill: string; callId: string; state: string; startedMs: number; endedMs: number; calls: number }): boolean;
      /** Each skill's runs kept in the folder across its sessions: how many, how many the user typed, how many failed, when the last started. */
      skillUsage(): { name: string; runs: number; typed: number; failed: number; lastMs: number }[];
      /** Keep the chosen agent's rate limits as it reported them (percent used, -1 unknown; resets in epoch seconds). */
      saveLimits(limits: { fiveHourPct: number; fiveHourResets: number; weekPct: number; weekResets: number }): boolean;
    };
    /** Short titles Claude writes for sessions, with a small model, one request at a time (Claude Code's sessions only). */
    titles: {
      configure(enabled: boolean, model: string): void;
      /** Ask for session `id`'s title from its first exchange (once, unless `again`); whether it was asked (never while another agent is chosen). */
      request(id: string, prompt: string, reply: string, again?: boolean): boolean;
      /** Called with each title Claude wrote. */
      onTitle(run: (id: string, title: string) => void): void;
    };
    /** The conversation with the agent (Claude Code, or one a plugin brings). */
    agent: {
      /** Which agent: its id in config.json and `--agent`, and its name as the screen says it. */
      info(): { id: string; name: string };
      /** The models, efforts and modes the agent offers ([] for a list it does not name: Claude Code takes any model alias). */
      choices(): { models: AgentOption[]; efforts: AgentOption[]; modes: AgentOption[] };
      /** The model alias the next start uses ("opus[1m]"; "" for the agent's default). */
      modelName(): string;
      /** Set the model for the next start without switching (a new session's default). */
      useModel(name: string): void;
      /** Switch the model: live when the agent runs, kept in the session's record. */
      setModel(name: string): void;
      /** The model's name for the screen ("Opus 5.5 1M"). */
      modelLabel(): string;
      /** The model the agent reported ("" before it started). */
      reportedModel(): string;
      started(): boolean;
      running(): boolean;
      /** The effort the agent reports, else the one asked for. */
      effort(): string;
      setEffort(level: string): void;
      /** The agent's mode (Claude Code's: "bypassPermissions", "plan", ...). */
      mode(): string;
      /** Switch modes, starting the agent if needed; "" or why not. */
      setMode(mode: string): string;
      interrupt(): void;
      /** Send a message (images it names by path attached); `error` is "" when sent. */
      send(text: string): { error: string; images: number };
      /** Start over with a new session. */
      reset(): void;
      resume(id: string, title?: string): void;
      sessionId(): string;
      title(): string;
      setTitle(title: string): void;
      firstExchange(): { prompt: string; reply: string };
      /** The agent's edits: a counter that moves with each, the last path and every path edited (folder-relative). */
      edits(): { seq: number; last: string; edited: string[] };
      /** The commit HEAD was on at a new session's first message ("" before). */
      headAtStart(): string;
      setHeadAtStart(sha: string): void;
      /** When the session started (epoch ms; 0 when unknown). */
      startMs(): number;
      /** Messages waiting for the turn to end. */
      queued(): number;
      /** The session's subagents, in the order they were called. */
      agents(): Agent[];
      /** Ask the agent a side question (/btw), answered in the chat and kept out of the conversation; "" or why not. */
      sideQuestion(question: string): string;
      /**
       * The tools the agent has, as its plugin last said (`known` false before it said), each with
       * the MCP server it comes from ("" for the agent's own), and its MCP servers; `ownKnown` false
       * when the agent lists none of its own.
       */
      tools(): { known: boolean; ownKnown: boolean; tools: { name: string; server: string; access: string; scope: string; calls: number }[]; servers: { name: string; status: string }[]; programs: { program: string; calls: number }[] };
      /**
       * The skills the agent has, as its plugin last said (`known` false before it said; `partial`
       * while the list is what the plugin found on disk before the agent started), each with
       * where it comes from, its file and the text that calls it; and the session's skill runs, oldest
       * first: a call that loaded a skill (`callId`, what openCall takes), or a skill the user typed
       * (`callId` ""), where it stands (running, done, failed, stopped), when it started and ended
       * (epoch ms; 0 for not yet) and how many calls the turn made after it.
       */
      skills(): { known: boolean; partial: boolean; skills: { name: string; description: string; source: string; path: string; command: string }[]; runs: { name: string; callId: string; state: string; startedMs: number; endedMs: number; calls: number }[] };
    };
    settings: {
      /** The plugin's section of config.json, null when it has none. */
      section(): unknown;
      /** What the plugin kept last run (~/.widecode/state.json), null for nothing. */
      state(): unknown;
      setState(value: unknown): void;
    };
  }

  /** A plugin the runtime registered: its state is "running", "failed" (`problem` says why), "off" (config.json), "replaced" (a later file's plugin has its id) or "stopped". */
  interface PluginInfo {
    id: string;
    file: string;
    state: string;
    problem: string;
  }

  /** What checking a plugin source found: whether it loads, the plugins it defines with what they require, its errors, and what to look at. */
  interface PluginCheck {
    ok: boolean;
    plugins: { id: string; requires: string[] }[];
    errors: string[];
    warnings: string[];
  }

  /** The project's harness folder as it stands: present or not, trusted or not, its plugin files, its prompt, its config beside the user's with the result of one over the other, and the tools the agent sees. */
  interface HarnessInfo {
    folder: string;
    dir: string;
    present: boolean;
    trusted: boolean;
    plugins: string[];
    prompt: { path: string; length: number };
    config: {
      path: string;
      present: boolean;
      notice: string;
      project: { plugins: unknown; columns: unknown; permissions: unknown };
      user: { plugins: unknown; columns: unknown; permissions: unknown };
      /** The project's over the user's; `permissions` as the agent gets them, `notice` what was left out of them ("" for nothing). */
      effective: { plugins: unknown; columns: unknown; permissions: { allow: string[]; ask: string[]; deny: string[] }; notice: string };
    };
    tools: string[];
  }

  interface Plugin {
    /** The name config.json and other plugins know it by; a plugin with the id of another replaces it. */
    id: string;
    /** Plugins that must be on for this one to start. */
    requires?: string[];
    /** Its section for a new config.json (true when it has no settings). */
    defaults?(): unknown;
    activate(api: Api): void;
    deactivate?(): void;
  }

  /** Register a plugin. */
  function plugin(def: Plugin): void;
  const version: number;
  /** Drawing helpers: widths in terminal cells (wide characters two, combining marks none), clipping with "…", padding, short times. */
  /** The colors the core draws with, by what they mean (theme.ts), and its spinner. */
  const theme: {
    /** Text that steps back. */
    dim: string;
    /** Done and added; failed and removed; running, asking or changed. */
    ok: string;
    bad: string;
    warn: string;
    /** The agent's own work: thinking, a subagent, a commit of this session. */
    think: string;
    /** What can be followed or is shown: a link, the shown tab. */
    link: string;
    code: string;
    /** The user's message. */
    prompt: string;
    /** A selected row; a row whose change the code column shows; a file that changed a moment ago. */
    selected: string;
    shown: string;
    fresh: string;
    /** The status band's background. */
    band: string;
    /** A file's git mark's color: M, A, U, D, R, !, and • for a folder holding changes. */
    marks: Record<string, string>;
    frames: readonly string[];
    /** The time between two frames of a spinner or a running clock, in ms. */
    tick: number;
    /** The spinner's frame at `now` (ms), one per tick. */
    spinner(now: number): string;
  };
  const util: {
    width(text: string): number;
    runsWidth(runs: Run[]): number;
    clip(text: string, cells: number): string;
    clipRuns(runs: Run[], cells: number): Run[];
    /** `runs` padded with spaces to `cells` (in place), answered. */
    pad(runs: Run[], cells: number): Run[];
    /** "12s", "3m", "2h20m", "25d". */
    age(ms: number): string;
    /** "45s", "12m", "1h5m". */
    elapsed(ms: number): string;
    /** "950", "12k", "1.2M". */
    tokens(n: number): string;
    /** The grapheme clusters of `text`, as the composer's caret counts them. */
    graphemes(text: string): string[];
    /** `v` when it is a string, else "". */
    str(v: unknown): string;
    /** `v` when it is a finite number, else `fallback` (0 by default). */
    num(v: unknown, fallback?: number): number;
    /** `v` when it is an array, else []. */
    list(v: unknown): unknown[];
    /** The strings in `v` (each via String), else []. */
    strs(v: unknown): string[];
    /** `v` when it is a plain object, else null. */
    obj(v: unknown): Record<string, unknown> | null;
    /** `text` parsed as JSON, or null. */
    parse(text: string): unknown;
    /** `text` quoted for sh. */
    quote(text: string): string;
    /** `text` split at spaces into lines of at most `cells` cells (a longer word is clipped). */
    wrap(text: string, cells: number): string[];
    /** `f`, run at most once per `ms` (the first call goes at once). */
    throttle(f: (...args: unknown[]) => void, ms: number): (...args: unknown[]) => void;
  };
}
