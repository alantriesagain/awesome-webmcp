// The plugin API's `process` calls, answered for the runtime (runtime.ts dispatches by namespace):
// a command run to its end, and a process kept running for its plugin.
import { PreludePart } from "@lightstart/plugins/prelude.ts";
import type { JsRuntime } from "../runtime/runtime.ts";
import { HostAnswer } from "@lightstart/plugins/engine.ts";
import { str, num, strs, answer } from "./values.ts";

/** Plugin call `name` with its arguments `a`, answered; null for a call of another namespace. */
export const answerProcess = (rt: JsRuntime, name: string, a: unknown[]): HostAnswer | null => {
  switch (name) {
    case "process.run":
      rt.runProcess(str(a[0]), str(a[1]), str(a[2]), num(a[3]), num(a[4]));
      return answer(null);
    case "process.spawn":
      return answer(rt.spawnProcess(str(a[0]), strs(a[1]), str(a[2]), num(a[3]), num(a[4]), num(a[5])));
    case "process.write": {
      const p = rt.process(num(a[0]));
      if (p !== null) p.write(str(a[1]));
      // A line to the agent the conversation talks to, for those who read them (tests).
      const c = rt.host.conversation;
      const hook = c.onWrite;
      if (p !== null && hook !== null && c.agent.owner === p.owner) hook(str(a[1]));
      return answer(p !== null);
    }
    case "process.stop": {
      const p = rt.process(num(a[0]));
      if (p !== null) p.stop(Math.max(0, num(a[1])));
      return answer(null);
    }
    case "process.kill": {
      const p = rt.process(num(a[0]));
      if (p !== null) p.kill();
      return answer(null);
    }
  }
  return null;
};

/** The `process` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_PROCESS = new PreludePart("process", `        run: (command, input, timeoutMs) => later("process.run", id, String(command), String(input ?? ""), Number(timeoutMs ?? 2000)),
        spawn: (command, options, handlers) => {
          const h = handlers ?? {};
          const pid = call("process.spawn", id, Array.from(command, String), String((options ?? {}).cwd ?? ""), opt(h.lines, (lines) => { h.lines(lines); }), opt(h.exit, (code) => { h.exit(code); }), opt(h.error, (text) => { h.error(text); }));
          return Object.freeze({
            started: pid >= 0,
            write: (line) => call("process.write", pid, String(line)),
            stop: (graceMs) => call("process.stop", pid, Number(graceMs ?? 3000)),
            kill: () => call("process.kill", pid),
          });
        },
`);
