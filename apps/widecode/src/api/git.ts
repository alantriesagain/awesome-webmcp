// The plugin API's `git` calls, answered for the runtime (runtime.ts dispatches by namespace): git
// read as promises (branches, the log, a commit's files, the bases), each settled for the plugin.
import { PreludePart } from "@light/plugins/prelude.ts";
import type { JsRuntime } from "../runtime/runtime.ts";
import { AheadBehind, Branch, Commit, CommitFile, LOG_MAX, RemoteBranch, readAheadBehind, readBranches, readCommitAt, readCommitFiles, readDefaultBranch, readHeadCommit, readLog, readMergeBase, readRemoteBranches, readRootCommit } from "@light/workspace/git-log.ts";
import { HostAnswer } from "@light/plugins/engine.ts";
import { str, num, json, refuse, commitOf, commitText, branchText, fileText, listText, objectText } from "./values.ts";

/** Plugin call `name` with its arguments `a`, answered; null for a call of another namespace. */
export const answerGit = (rt: JsRuntime, name: string, a: unknown[]): HostAnswer | null => {
  const ws = rt.host.workspace;
  switch (name) {
    case "git.branches":
      return rt.settled(str(a[0]), num(a[1]), readBranches(ws.repo, ws.folder).then((list: Branch[]) => listText(list.map(branchText))));
    case "git.log":
      return rt.settled(str(a[0]), num(a[3]), readLog(ws.repo, ws.folder, str(a[1]), Math.max(1, Math.min(LOG_MAX, num(a[2])))).then((list: Commit[]) => listText(list.map(commitText))));
    case "git.commitFiles": {
      const c = commitOf(a[1]);
      if (c === null) return refuse("git.commitFiles: a commit is { sha, short, subject, parents }");
      return rt.settled(str(a[0]), num(a[2]), readCommitFiles(ws.repo, ws.folder, c).then((list: CommitFile[]) => listText(list.map(fileText))));
    }
    case "git.defaultBranch":
      return rt.settled(str(a[0]), num(a[1]), readDefaultBranch(ws.repo, ws.folder).then((name: string) => json(name)));
    case "git.mergeBase":
      return rt.settled(str(a[0]), num(a[2]), readMergeBase(ws.repo, ws.folder, str(a[1])).then((sha: string) => json(sha)));
    case "git.head":
      return rt.settled(str(a[0]), num(a[1]), readHeadCommit(ws.repo, ws.folder).then((sha: string) => json(sha)));
    case "git.commitAt":
      return rt.settled(str(a[0]), num(a[2]), readCommitAt(ws.repo, ws.folder, num(a[1])).then((sha: string) => json(sha)));
    case "git.aheadBehind":
      return rt.settled(str(a[0]), num(a[3]), readAheadBehind(ws.repo, ws.folder, str(a[1]), str(a[2])).then((r: AheadBehind) => objectText(["ahead", "behind"], [String(r.ahead), String(r.behind)])));
    case "git.rootCommit":
      return rt.settled(str(a[0]), num(a[1]), readRootCommit(ws.repo, ws.folder).then((sha: string) => json(sha)));
    case "git.remoteBranches":
      return rt.settled(
        str(a[0]),
        num(a[2]),
        readRemoteBranches(ws.repo, ws.folder, str(a[1])).then((list: RemoteBranch[]) =>
          listText(list.map((b: RemoteBranch) => objectText(["name", "ref", "sha", "commitMs", "local", "ahead", "behind"], [json(b.name), json(b.ref), json(b.sha), String(b.commitMs), String(b.local), String(b.ahead), String(b.behind)]))),
        ),
      );
  }
  return null;
};

/** The `git` namespace of the plugin API, its JS side: the calls these answers take. */
export const NAMESPACE_GIT = new PreludePart("git", `        branches: () => later("git.branches", id),
        log: (ref, max) => later("git.log", id, String(ref), Number(max ?? 200)),
        commitFiles: (commit) => later("git.commitFiles", id, commit),
        defaultBranch: () => later("git.defaultBranch", id),
        mergeBase: (ref) => later("git.mergeBase", id, String(ref)),
        head: () => later("git.head", id),
        commitAt: (ms) => later("git.commitAt", id, Number(ms)),
        aheadBehind: (a, b) => later("git.aheadBehind", id, String(a), String(b)),
        rootCommit: () => later("git.rootCommit", id),
        remoteBranches: (remote) => later("git.remoteBranches", id, String(remote)),
`);
