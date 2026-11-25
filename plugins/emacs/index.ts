// The emacs keymap, the one in use unless config.json's "keymap" or /keymap says otherwise. The
// composer has readline's keys already (Ctrl+A/E/U/K/W/D/H/J/Y/_, Alt+B/F, Alt+Backspace); this
// layer adds the rest: Ctrl+F/B by a character, Ctrl+P/N by a line, Alt+D deletes the word after
// the caret, Alt+< and Alt+> go to the chat's start and end. Enter sends, as everywhere in
// lightcode (keys.json can give Enter to editor.newline and Alt+Enter to editor.submit). The layer
// is on while the keymap is in use.

const u = lightcode.util;

/** A grapheme of a word: anything but whitespace and ASCII punctuation (as the composer's word moves count). */
const inWord = (g: string): boolean => {
  if (g.trim().length === 0) return false;
  const c = g.codePointAt(0) ?? 0;
  if (c === 95) return true;
  return !((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126));
};

lightcode.plugin({
  id: "emacs",
  activate(api) {
    // The word after the caret, deleted; at a line's end, the line joins the next.
    api.keys.action({
      id: "emacs.deleteWordForward",
      scope: "input",
      help: "deletes the word after",
      run: (_key, count) => {
        for (let n = 0; n < Math.max(1, count); n++) {
          const c = api.composer.get();
          const gs = u.graphemes(c.lines[c.row] ?? "");
          if (c.col >= gs.length) {
            api.keys.run("editor.delete", 1);
            continue;
          }
          let i = c.col;
          while (i < gs.length && !inWord(gs[i])) i++;
          while (i < gs.length && inWord(gs[i])) i++;
          const lines = c.lines.slice();
          lines[c.row] = gs.slice(0, c.col).join("") + gs.slice(i).join("");
          api.composer.set(lines, c.row, c.col);
        }
        return true;
      },
    });
    const layer = api.keys.layer("emacs", {
      input: {
        "ctrl+char:f": "editor.right",
        "ctrl+char:b": "editor.left",
        "ctrl+char:p": "editor.up",
        "ctrl+char:n": "editor.down",
        "alt+char:d": "emacs.deleteWordForward",
      },
      chat: {
        "alt+char:<": "chat.top",
        "alt+char:>": "chat.end",
      },
    });
    const follow = (): void => {
      if (api.state.keymap() === "emacs") layer.on();
      else layer.off();
    };
    api.keys.keymap({ id: "emacs", name: "emacs" });
    api.on("keymapChanged", follow);
    follow();
  },
});

export {};
