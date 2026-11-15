// The menu bar's menus: Session, Pane, View and Help, each row an action the keymap may bind, so a
// row shows the key that runs it. A command with no action of its own gets one here (`menus.new`
// runs /new), and the active column moves left or right through `ui.moveColumn`. They have no help
// text, so they add no hints to the status bar: the menu row says what each does.

/** An action running command `text`, for a menu row. */
const commandAction = (api: widecode.Api, id: string, text: string): void => {
  api.keys.action({ id, run: () => api.commands.run(text) });
};

/** Move the active column one place: -1 left, 1 right. */
const moveActive = (api: widecode.Api, step: number): boolean => {
  const columns = api.state.columns();
  for (let i = 0; i < columns.length; i++) if (columns[i].active) return api.ui.moveColumn(columns[i].id, i + step);
  return false;
};

widecode.plugin({
  id: "menus",
  activate(api) {
    commandAction(api, "menus.new", "/new");
    commandAction(api, "menus.resume", "/resume");
    commandAction(api, "menus.compact", "/compact");
    commandAction(api, "menus.changed", "/files changed");
    api.keys.action({ id: "menus.column.left", run: () => moveActive(api, -1) });
    api.keys.action({ id: "menus.column.right", run: () => moveActive(api, 1) });

    const rows: [string, string, string][] = [
      ["Session", "New session", "menus.new"],
      ["Session", "Resume", "menus.resume"],
      ["Session", "Compact", "menus.compact"],
      ["Session", "-", ""],
      ["Session", "Quit", "app.quit"],
      ["Pane", "Chat", "app.focus.chat"],
      ["Pane", "Files", "app.focus.side"],
      ["Pane", "Code", "app.focus.code"],
      ["Pane", "Tools", "app.focus.tools"],
      ["Pane", "-", ""],
      ["Pane", "Previous column", "app.column.previous"],
      ["Pane", "Next column", "app.column.next"],
      ["Pane", "-", ""],
      ["Pane", "Move column left", "menus.column.left"],
      ["Pane", "Move column right", "menus.column.right"],
      ["View", "Wrap lines", "code.wrap"],
      ["View", "Follow edits", "code.follow"],
      ["View", "Changed files", "menus.changed"],
      ["Help", "Keys and commands", "app.help"],
    ];
    for (let i = 0; i < rows.length; i++) api.ui.menu({ menu: rows[i][0], label: rows[i][1], action: rows[i][2], order: i });
  },
});
