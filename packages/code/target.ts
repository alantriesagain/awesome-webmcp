// The code column's role, as other plugins use it: a class with no-op methods the plugin playing
// it overrides (an app holds one, replaced when that plugin goes).
import { LineSource } from "@bootstrapp/light/native/tui/lines.ts";
import { Commit } from "@light/workspace/git-log.ts";
import { CodeFile } from "./diff.ts";

/** The code column, as other plugins use it. */
export class CodeTarget {
  /** The plugin playing the role ("" for none). */
  owner = "";

  /** Show `path` (folder-relative) with its changes against the compare base. */
  open(_path: string): void {}

  /** Show `path` as `commit` changed it. */
  openCommit(_commit: Commit, _path: string, _mark: string): void {}

  /** The file shown ("" for none). */
  path(): string {
    return "";
  }

  /** The file shown, as loaded. */
  file(): CodeFile {
    return new CodeFile();
  }

  /** Whether it shows a commit's change rather than the work tree. */
  inCommit(): boolean {
    return false;
  }

  /** Show the steps of the subagent called by tool use `id` in place of the file. */
  openAgent(_id: string): void {}

  /** Show tool call `id` whole in place of the file: its input and output (a subagent's call: its steps). */
  openCall(_id: string): void {}

  /** Whether it shows a subagent's steps or a call rather than a file. */
  inAgent(): boolean {
    return false;
  }

  /** Show a plugin's own rows (`source`) in place of the file, titled `title`; a press on a row goes to `onPress`. Esc goes back. */
  openView(_source: LineSource, _title: string, _onPress: ((row: number) => void) | null): void {}

  /** Where the view is among the file's changes ("change 2/5 · L40"). */
  position(): string {
    return "";
  }
}
