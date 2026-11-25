// Drafts saved for later: /queue with text queues that text, /queue alone takes the composer's text
// (clearing it), and /queue with nothing there says so. The Queue tab of the tools column lists each
// queued draft as a clipped line, its link's badge counting them. A press on a draft puts it back in
// the composer, takes it off the queue (the composer's own text, if any, taking its place) and focuses
// the chat; nothing sends it on its own.

const T = lightcode.theme;
const DIM = T.dim;

lightcode.plugin({
  id: "queue",
  activate(api) {
    const u = lightcode.util;
    const drafts: string[] = [];

    /** Add `text` to the queue and say how many wait. */
    const put = (text: string): void => {
      drafts.push(text);
      panel.refresh();
      api.tell("queued a draft (" + String(drafts.length) + " waiting)");
    };

    api.commands.add({
      name: "/queue",
      usage: "[text]",
      help: "save a draft to send later",
      run: (arg) => {
        if (arg.length > 0) {
          put(arg);
          return;
        }
        const c = api.composer.get();
        if (c.empty) {
          api.tell("nothing to queue");
          return;
        }
        put(c.lines.join("\n"));
        api.composer.set([""], 0, 0);
      },
    });

    const panel = api.ui.panel({
      id: "queue",
      title: "Queue",
      column: "tools",
      order: 3,
      width: (cols) => Math.max(32, Math.min(44, Math.floor(cols / 7))),
      count: () => drafts.length,
      rows: (from, n, width) => {
        const out: lightcode.Row[] = [];
        for (const d of drafts.slice(from, from + n)) {
          out.push({ runs: [{ text: " " + u.clip(d.replace(/\s+/g, " ").trim(), Math.max(4, width - 1)), fg: "" }] });
        }
        return out;
      },
      info: () => [{ text: " " + String(drafts.length) + (drafts.length === 1 ? " queued draft" : " queued drafts"), fg: DIM }],
      badge: () => (drafts.length > 0 ? [{ text: String(drafts.length), fg: DIM }] : []),
      press: (row) => {
        const d = drafts[row];
        if (d === undefined) return;
        // What the composer holds takes the draft's place, so nothing typed is lost.
        const c = api.composer.get();
        if (c.empty) drafts.splice(row, 1);
        else drafts[row] = c.lines.join("\n");
        const lines = d.split("\n");
        api.composer.set(lines, lines.length - 1, u.graphemes(lines[lines.length - 1] ?? "").length);
        panel.refresh();
        api.actions.focus("chat");
        api.tell(c.empty ? "queued draft back in the composer" : "queued draft back in the composer; what was there took its place");
      },
    });
  },
});

export {};
