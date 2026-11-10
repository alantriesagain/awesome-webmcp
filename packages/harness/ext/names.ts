// The built-in tools as pi names them, and their inputs in pi's shape. An extension written for pi
// checks `event.toolName === "bash"` and `event.input.command`, so a tool the two share reaches
// `tool_call` and `tool_result` under pi's name and pi's arguments; a field with no counterpart
// keeps its own name, and a change to the mapped input is mapped back before the call runs. A tool
// only widecode has keeps its own name and input.
import { listOf, parseJson, recordOf } from "@light/lib/json.ts";

const PI_NAMES: string[][] = [
  ["Bash", "bash"],
  ["Read", "read"],
  ["Write", "write"],
  ["Edit", "edit"],
  ["Grep", "grep"],
  ["Glob", "find"],
  ["LS", "ls"],
];

const piNameOf = (harnessName: string): string => {
  for (const pair of PI_NAMES) if (pair[0] === harnessName) return pair[1];
  return harnessName;
};

const harnessNameOf = (piName: string): string => {
  for (const pair of PI_NAMES) if (pair[1] === piName) return pair[0];
  return piName;
};

const copy = (input: Record<string, unknown>): Record<string, unknown> => recordOf(parseJson(JSON.stringify(input))) ?? {};

/** `input` in pi's shape for tool `harnessName` (unchanged for a tool pi lacks). */
export const toPiInput = (harnessName: string, input: Record<string, unknown>): Record<string, unknown> => {
  const out = copy(input);
  switch (harnessName) {
    case "Bash": {
      const timeout = out["timeout"];
      if (typeof timeout === "number") out["timeout"] = Math.round((timeout / 1000) * 1000) / 1000;
      return out;
    }
    case "Read":
    case "Write": {
      if (out["file_path"] !== undefined) {
        out["path"] = out["file_path"];
        delete out["file_path"];
      }
      return out;
    }
    case "Edit": {
      if (out["file_path"] !== undefined) {
        out["path"] = out["file_path"];
        delete out["file_path"];
      }
      const oldText = out["old_string"];
      const newText = out["new_string"];
      if (typeof oldText === "string" && typeof newText === "string") {
        out["edits"] = [{ oldText, newText }];
        delete out["old_string"];
        delete out["new_string"];
      }
      return out;
    }
    case "Grep": {
      if (out["include"] !== undefined) {
        out["glob"] = out["include"];
        delete out["include"];
      }
      return out;
    }
    default:
      return out;
  }
};

/** `input` from pi's shape back to tool `harnessName`'s. */
export const fromPiInput = (harnessName: string, input: Record<string, unknown>): Record<string, unknown> => {
  const out = copy(input);
  switch (harnessName) {
    case "Bash": {
      const timeout = out["timeout"];
      if (typeof timeout === "number") out["timeout"] = Math.round(timeout * 1000);
      return out;
    }
    case "Read":
    case "Write": {
      if (out["path"] !== undefined) {
        out["file_path"] = out["path"];
        delete out["path"];
      }
      return out;
    }
    case "Edit": {
      if (out["path"] !== undefined) {
        out["file_path"] = out["path"];
        delete out["path"];
      }
      const edits = listOf(out["edits"]);
      const first = edits.length > 0 ? recordOf(edits[0]) : null;
      if (first !== null) {
        if (typeof first["oldText"] === "string") out["old_string"] = first["oldText"];
        if (typeof first["newText"] === "string") out["new_string"] = first["newText"];
      } else if (typeof out["oldText"] === "string" && typeof out["newText"] === "string") {
        out["old_string"] = out["oldText"];
        out["new_string"] = out["newText"];
        delete out["oldText"];
        delete out["newText"];
      }
      delete out["edits"];
      return out;
    }
    case "Grep": {
      if (out["glob"] !== undefined) {
        out["include"] = out["glob"];
        delete out["glob"];
      }
      return out;
    }
    default:
      return out;
  }
};

export { piNameOf, harnessNameOf };
