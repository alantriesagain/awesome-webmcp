// Alerts when a request waits for the user in the request panel (a permission, a question, a plan
// to approve), who may be in another window: the terminal's bell, and a desktop notification from
// notify-send. config.json's "alerts" section is
//   { "bell": true, "notify": true, "on": ["permission", "question"], "notifyCommand": ["notify-send"], "onClick": "guake --show" }
// where `on` names the request categories that alert ("permission", "question", "plan"),
// `notifyCommand` is the program to run (the name and then its arguments) with the title and the
// summary as its last two arguments, and `onClick` is a shell line to run when the notification is
// clicked ("" or absent for none; notify-send waits for the click and says `open`), for example
// "guake --show" to bring the terminal up. A request alerts once while it is still open; one
// answered at once does not. Only the real app alerts: a test or a selftest never reaches the
// user's desktop.

/** The section as config.json may write it: every field `unknown` until it is read. */
interface AlertsSection {
  bell?: unknown;
  notify?: unknown;
  on?: unknown;
  notifyCommand?: unknown;
  onClick?: unknown;
}

/** A word or phrase as one shell argument. */
const quote = (text: string): string => "'" + text.replace(/'/g, "'\\''") + "'";

/** `value` as the list of strings it holds, else `fallback` (a non-empty list). */
const stringsOf = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) return fallback;
  const out: string[] = [];
  for (const v of value as unknown[]) out.push(String(v));
  return out.length > 0 ? out : fallback;
};

widecode.plugin({
  id: "alerts",
  defaults: () => ({ bell: true, notify: true, on: ["permission", "question"], onClick: "" }),
  activate(api) {
    const raw = api.settings.section();
    const section: AlertsSection = raw !== null && typeof raw === "object" ? (raw as AlertsSection) : {};
    const bell = section.bell !== false;
    const notify = section.notify !== false;
    const categories = stringsOf(section.on, ["permission", "question"]);
    const command = stringsOf(section.notifyCommand, ["notify-send"]);
    const onClick = typeof section.onClick === "string" ? section.onClick : "";

    api.on("requestOpened", (request) => {
      if (!api.state.real() || !categories.includes(request.category)) return;
      if (bell) api.ui.bell();
      if (!notify) return;
      const summary = request.summary.length > 0 ? request.summary : request.name;
      const action = onClick.length > 0 ? " -A open=Open" : "";
      const line = command.map(quote).join(" ") + action + " " + quote("widecode: " + request.category) + " " + quote(summary);
      // A missing notify-send fails quietly: the bell already carried the alert. With onClick,
      // notify-send waits for the click: its `open` runs that line and shows the request.
      api.process
        .run(line, "", onClick.length > 0 ? 86400000 : 2000)
        .then((result) => {
          if (onClick.length === 0 || result.out.trim() !== "open") return;
          api.process.run(onClick).catch(() => {});
          api.actions.focus("chat");
          api.chat.showRequest(request.id);
        })
        .catch(() => {});
    });
  },
});
