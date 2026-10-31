// Alerts when a request waits for the user in the request panel (a permission, a question, a plan
// to approve), who may be in another window: the terminal's bell, and a desktop notification from
// notify-send. config.json's "alerts" section is
//   { "bell": true, "notify": true, "on": ["permission", "question"], "notifyCommand": ["notify-send"] }
// where `on` names the request categories that alert ("permission", "question", "plan"), and
// `notifyCommand` is the program to run (the name and then its arguments) with the title and the
// summary as its last two arguments. A request alerts once, when it opens; one answered at once
// still alerts.

/** The section as config.json may write it: every field `unknown` until it is read. */
interface AlertsSection {
  bell?: unknown;
  notify?: unknown;
  on?: unknown;
  notifyCommand?: unknown;
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
  defaults: () => ({ bell: true, notify: true, on: ["permission", "question"] }),
  activate(api) {
    const raw = api.settings.section();
    const section: AlertsSection = raw !== null && typeof raw === "object" ? (raw as AlertsSection) : {};
    const bell = section.bell !== false;
    const notify = section.notify !== false;
    const categories = stringsOf(section.on, ["permission", "question"]);
    const command = stringsOf(section.notifyCommand, ["notify-send"]);

    api.on("requestOpened", (request) => {
      if (!categories.includes(request.category)) return;
      if (bell) api.ui.bell();
      if (!notify) return;
      const summary = request.summary.length > 0 ? request.summary : request.name;
      const line = command.map(quote).join(" ") + " " + quote("widecode: " + request.category) + " " + quote(summary);
      // A missing notify-send fails quietly: the bell already carried the alert.
      api.process.run(line).catch(() => {});
    });
  },
});
