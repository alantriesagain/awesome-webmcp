// The deny rules: parsed from config.json's `permissions.deny`; Bash rules over each simple command
// (a glob, the old prefix form, `git push *` covering `git push` alone); Read's paths covering Grep,
// Glob and LS, Edit's covering Write (in the folder, from the root, in the home, at any depth, a
// folder's contents); WebFetch by domain and its subdomains; a tool whole; MCP tools by server and
// by name; then a refused call in the loop (it does not run, the model is told the rule) and the
// tools listing's rules for the acp plugin.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Abort } from "../src/harness/loop/abort.ts";
import { LoopListener } from "../src/harness/loop/listener.ts";
import { AgentLoop, LoopSession } from "../src/harness/loop/loop.ts";
import { ModelClient } from "../src/harness/model/client.ts";
import { FakeClient } from "../src/harness/model/fake.ts";
import { Auth } from "../src/harness/auth.ts";
import { registryFor } from "../src/harness/cli.ts";
import { HarnessConfig } from "../src/harness/config.ts";
import { deniedBy, listingRules, parseRules, rulesIn } from "../src/harness/tools/permissions.ts";
import { ToolOutcome, ToolSet, builtInTools } from "../src/harness/tools/tool.ts";
import { done, eq } from "@lightstart/test/assert.ts";

const folder = mkdtempSync(join(tmpdir(), "harness-deny-"));
const config = join(folder, "config.json");
writeFileSync(config, JSON.stringify({ permissions: { deny: ["Bash(git push *)", "Bash(rm -rf:*)", "Read(./.env)", "Read(secrets/)", "Edit(/etc/**)", "Read(~/.ssh/**)", "Read(**/*.pem)", "WebFetch(domain:example.com)", "WebSearch", "mcp__widecode__reload", "mcp__other", "not a rule("] } }));
const rules = parseRules(rulesIn(config));
eq("the rules it reads", rules.map((r) => r.tool + (r.specifier.length > 0 ? "(" + r.specifier + ")" : "")).join(" "), "Bash(git push *) Bash(rm -rf:*) Read(./.env) Read(secrets/) Edit(/etc/**) Read(~/.ssh/**) Read(**/*.pem) WebFetch(domain:example.com) WebSearch mcp__widecode__reload mcp__other");
const home = "/home/u";
const denied = (tool: string, input: unknown): string => deniedBy(rules, tool, (input as Record<string, unknown>) ?? {}, folder, home);
eq("Bash: a command the glob matches, in a compound line too", [denied("Bash", { command: "git push origin main" }), denied("Bash", { command: "git status && git push" }), denied("Bash", { command: "git pull" })].join(" | "), "Bash(git push *) | Bash(git push *) | ");
eq("the prefix form", [denied("Bash", { command: "rm -rf build" }), denied("Bash", { command: "rm build" })].join(" | "), "Bash(rm -rf:*) | ");
eq("Read: the folder's .env, by its relative or absolute path, and by Grep in it", [denied("Read", { file_path: ".env" }), denied("Read", { file_path: join(folder, ".env") }), denied("Grep", { pattern: "x", path: ".env" }), denied("Read", { file_path: ".env.example" })].join(" | "), "Read(./.env) | Read(./.env) | Read(./.env) | ");
eq("a folder's contents, by Read and by LS", [denied("Read", { file_path: "secrets/a.txt" }), denied("LS", { path: "secrets" }), denied("Read", { file_path: "notes/secrets.txt" })].join(" | "), "Read(secrets/) | Read(secrets/) | ");
eq("Edit from the root covers Write; Read of it is let be", [denied("Write", { file_path: "/etc/hosts", content: "" }), denied("Edit", { file_path: "/etc/x/y.conf" }), denied("Read", { file_path: "/etc/hosts" })].join(" | "), "Edit(/etc/**) | Edit(/etc/**) | ");
eq("in the home, at any depth", [denied("Read", { file_path: "/home/u/.ssh/id_ed25519" }), denied("Read", { file_path: "deep/keys/server.pem" })].join(" | "), "Read(~/.ssh/**) | Read(**/*.pem)");
eq("WebFetch by domain and its subdomains", [denied("WebFetch", { url: "https://example.com/x" }), denied("WebFetch", { url: "https://docs.example.com/" }), denied("WebFetch", { url: "https://notexample.com/" })].join(" | "), "WebFetch(domain:example.com) | WebFetch(domain:example.com) | ");
eq("a tool whole; MCP tools by name and by server", [denied("WebSearch", { query: "x" }), denied("mcp__widecode__reload", {}), denied("mcp__widecode__state", {}), denied("mcp__other__thing", {})].join(" | "), "WebSearch | mcp__widecode__reload |  | mcp__other");
eq("the tools listing's rules: everything allowed, the tools denied whole", listingRules(rules), '[{"permission":"*","pattern":"*","action":"allow"},{"permission":"WebSearch","pattern":"*","action":"deny"},{"permission":"widecode_reload","pattern":"*","action":"deny"},{"permission":"other_*","pattern":"*","action":"deny"}]');
eq("no rules, none listed", listingRules([]), "[]");

const main = async (): Promise<void> => {
  const reg = registryFor(new HarnessConfig(), true);
  const fixture = '{"match":"push","text":"Pushing.","tools":[{"name":"Bash","input":{"command":"touch pushed && git push"}}]}\n{"match":"result","text":"It was refused."}';
  const loop = new AgentLoop(new ModelClient(reg, new Auth(join(folder, "auth.json")), "node", FakeClient.fromText(fixture)), new ToolSet(builtInTools()));
  const s = new LoopSession();
  s.model = "fake/fake";
  s.cwd = folder;
  s.deny = rules;
  const l = new LoopListener();
  const outcomes: string[] = [];
  l.onToolEnd = (_id: string, o: ToolOutcome) => outcomes.push(String(o.isError) + " " + o.text);
  const end = await loop.run(s, "push it", l, new Abort());
  eq("a refused call does not run; the model is told the rule", outcomes.join("") + " | " + String(existsSync(join(folder, "pushed"))) + " | " + end.stopReason, "true refused by the rule Bash(git push *) in permissions.deny: take another way, or ask the user | false | end_turn");
  rmSync(folder, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
