// Alerts when a request waits for the user in the request panel (a permission, a question, a plan
// to approve), who may be in another window: the terminal's bell, and a desktop notification from
// notify-send. config.json's "alerts" section is
//   { "bell": true, "notify": true, "on": ["permission", "question"], "notifyCommand": ["notify-send"], "onClick": "guake --show", "expireSeconds": 600 }
// where `on` names the request categories that alert ("permission", "question", "plan"),
// `notifyCommand` is the program to run (the name and then its arguments) with the title and the
// summary as its last two arguments, `onClick` is a shell line to run when the notification is
// clicked ("" or absent for none; notify-send waits for the click and says `open`), for example
// "guake --show" to bring the terminal up, and `expireSeconds` is how long the notification stays
// on screen (600 by default; a non-number or a value <= 0 falls back to the default). notify-send
// gets it as -t and runs under coreutils `timeout`, so its process ends even if lightcode quits
// first; another notifyCommand runs as written. A request alerts once while it is still open; one
// answered at once does not. Only the real app alerts: a test or a selftest never reaches the
// user's desktop.

/** The section as config.json may write it: every field `unknown` until it is read. */
interface AlertsSection {
  bell?: unknown;
  notify?: unknown;
  on?: unknown;
  notifyCommand?: unknown;
  onClick?: unknown;
  expireSeconds?: unknown;
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

lightcode.plugin({
  id: "alerts",
  defaults: () => ({ bell: true, notify: true, on: ["permission", "question"], onClick: "", expireSeconds: 600 }),
  activate(api) {
    const raw = api.settings.section();
    const section: AlertsSection = raw !== null && typeof raw === "object" ? (raw as AlertsSection) : {};
    const bell = section.bell !== false;
    const notify = section.notify !== false;
    const categories = stringsOf(section.on, ["permission", "question"]);
    const command = stringsOf(section.notifyCommand, ["notify-send"]);
    const onClick = typeof section.onClick === "string" ? section.onClick : "";
    const configured = section.expireSeconds;
    const expireSeconds = typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : 600;
    const program = command[0].slice(command[0].lastIndexOf("/") + 1);
    const notifySend = program === "notify-send";
    const expire = notifySend ? " -t " + String(expireSeconds * 1000) : "";
    const bound = expireSeconds + 5;
    const wrap = notifySend ? "timeout " + String(bound) + " " : "";

    api.on("requestOpened", (request) => {
      if (!api.state.real() || !categories.includes(request.category)) return;
      if (bell) api.ui.bell();
      if (!notify) return;
      const summary = request.summary.length > 0 ? request.summary : request.name;
      const action = onClick.length > 0 ? " -A open=Open" : "";
      const line = command.map(quote).join(" ") + action + expire + " " + quote("lightcode: " + request.category) + " " + quote(summary);
      // A missing notify-send fails quietly: the bell already carried the alert. With onClick,
      // notify-send waits for the click: its `open` runs that line and shows the request. Coreutils'
      // timeout ends notify-send if lightcode quit before the notification expired.
      api.process
        .run(wrap + line, "", onClick.length > 0 ? bound * 1000 : 2000)
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
