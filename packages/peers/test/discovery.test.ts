// Discovery's parsers over the tools' recorded output (a Linux box and a Mac announcing to each
// other on 24 October 2026): avahi's parsable lines, one machine at its best address; dns-sd's
// zone listing, SRV and TXT per instance; dscacheutil's addresses; the TXT pairs; the announce
// commands per platform; and the daemon taking a browse in: a paired peer marked seen, an unknown
// machine listed nearby and joinable by name.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Advertiser, DaemonOptions, Seen, instanceName, parseAvahi, parseDnsSdZone, parseDscacheutil, parseTxt, startDaemon } from "@widecode/peers";
import { done, eq, eqn, ok } from "@light/test/assert.ts";

const AVAHI = [
  "+;virbr0;IPv4;widecode-linux-test;_widecode._tcp;local",
  "+;wlo1;IPv6;widecode-linux-test;_widecode._tcp;local",
  '=;virbr0;IPv4;widecode-linux-test;_widecode._tcp;local;alanleal-730QDA.local;192.168.122.1;7337;"name=linux" "id=abc123"',
  '=;wlo1;IPv6;widecode-linux-test;_widecode._tcp;local;alanleal-730QDA.local;2804:7f1:eb43:935d:52c3:c986:abc4:eeda;7337;"name=linux" "id=abc123"',
  '=;wlo1;IPv4;widecode-linux-test;_widecode._tcp;local;alanleal-730QDA.local;192.168.15.57;7337;"name=linux" "id=abc123"',
  '=;lo;IPv4;widecode-linux-test;_widecode._tcp;local;alanleal-730QDA.local;127.0.0.1;7337;"name=linux" "id=abc123"',
  '=;wlo1;IPv6;widecode-mac-test;_widecode._tcp;local;Alans-MacBook-Pro.local;192.168.15.51;7338;"name=mac" "id=def456"',
  '=;wlo1;IPv4;widecode-mac-test;_widecode._tcp;local;Alans-MacBook-Pro.local;192.168.15.51;7338;"name=mac" "id=def456"',
  "",
].join("\n");

const ZONE = [
  "Browsing for _widecode._tcp",
  "DATE: ---Sat 24 Oct 2026---",
  "17:50:03.767  ...STARTING...",
  "",
  "; To direct clients to browse a different domain, substitute that domain in place of '@'",
  "lb._dns-sd._udp                                 PTR     @",
  "",
  "_widecode._tcp                                  PTR     widecode-linux-test._widecode._tcp",
  "widecode-linux-test._widecode._tcp              SRV     0 0 7337 alanleal-730QDA.local. ; Replace with unicast FQDN of target host",
  'widecode-linux-test._widecode._tcp              TXT     "id=abc123" "name=linux"',
  "_widecode._tcp                                  PTR     widecode-def456._widecode._tcp",
  "widecode-def456._widecode._tcp                  SRV     0 0 7338 Alans-MacBook-Pro.local. ; Replace with unicast FQDN of target host",
  'widecode-def456._widecode._tcp                  TXT     "id=def456" "name=mac"',
  "",
].join("\n");

const DSCACHE = ["name: alanleal-730qda.local", "ipv6_address: 2804:7f1:eb43:935d:a214:63b6:7ff7:66be", "ipv6_address: 2804:7f1:eb43:935d:52c3:c986:abc4:eeda", "", "name: alanleal-730qda.local", "ip_address: 192.168.15.57", ""].join("\n");

{
  const txt = parseTxt('"name=linux" "id=abc123" "junk" "x=a=b"');
  eq("TXT pairs", txt["name"] + " " + txt["id"] + " " + txt["x"] + " " + String(txt["junk"]), "linux abc123 a=b undefined");
  const seen = parseAvahi(AVAHI);
  eqn("one machine per id", seen.length, 2);
  const linux = seen.find((s: Seen) => s.id === "abc123")!;
  const mac = seen.find((s: Seen) => s.id === "def456")!;
  eq("the Linux box at its private IPv4, not the bridge, the loopback or the IPv6", linux.address + ":" + String(linux.port) + " " + linux.name + " " + linux.host, "192.168.15.57:7337 linux alanleal-730QDA.local");
  eq("the Mac as the Linux box sees it", mac.address + ":" + String(mac.port) + " " + mac.name, "192.168.15.51:7338 mac");
  eqn("lines that are no record are skipped", parseAvahi("+;wlo1;IPv4;x;_widecode._tcp;local\nnonsense\n").length, 0);
}

{
  const zone = parseDnsSdZone(ZONE);
  eqn("two instances", zone.length, 2);
  eq("SRV gives the host and port, TXT the id and name", zone.map((e) => e.instance + "=" + e.host + ":" + String(e.port) + "/" + e.txt["id"] + "/" + e.txt["name"]).join(" "), "widecode-linux-test=alanleal-730QDA.local:7337/abc123/linux widecode-def456=Alans-MacBook-Pro.local:7338/def456/mac");
  eq("dscacheutil's IPv4", parseDscacheutil(DSCACHE).join(","), "192.168.15.57");
  eqn("no address when it says none", parseDscacheutil("name: x.local\n").length, 0);
}

{
  eq("the instance name is the id's first eight digits", instanceName("def4567890abcdef"), "widecode-def45678");
  eq("announce on Linux", Advertiser.command("linux", "abc123", "linux", 7337).join(" "), "avahi-publish-service widecode-abc123 _widecode._tcp 7337 id=abc123 name=linux");
  eq("announce on macOS", Advertiser.command("darwin", "def456", "mac", 7338).join(" "), "dns-sd -R widecode-def456 _widecode._tcp . 7338 id=def456 name=mac");
}

const root = mkdtempSync(join(tmpdir(), "widecode-peers-disc-"));
const main = async (): Promise<void> => {
  mkdirSync(join(root, "a"));
  const o = new DaemonOptions();
  o.port = 0;
  o.bind = "127.0.0.1";
  o.discovery = false;
  const a = await startDaemon(join(root, "a"), o);
  if (typeof a === "string") throw new Error(a);
  const now = 5000000;
  a.noteSeen([new Seen(a.identity.id, "myself", "192.168.1.9", a.port, "me.local"), new Seen("f".repeat(64), "studio", "192.168.1.20", 7337, "studio.local")], now);
  eqn("this machine's own announcement is not a nearby machine", a.nearby.length, 1);
  eq("an unknown machine is nearby", a.nearby[0].name + " " + a.nearby[0].address, "studio 192.168.1.20");
  const target = a.resolveTarget("studio", 7337);
  eq("a join may name a nearby machine", target.address + ":" + String(target.port), "192.168.1.20:7337");
  const byHost = a.resolveTarget("studio.local", 1);
  eq("or its host", byHost.address + ":" + String(byHost.port), "192.168.1.20:7337");
  const typed = a.resolveTarget("10.0.0.7", 7337);
  eq("a typed address stays", typed.address + ":" + String(typed.port), "10.0.0.7:7337");
  ok("the state lists it", JSON.stringify(a.stateJson(now)).includes('"nearby":[{"id":"ffff'));
  a.stop();
  rmSync(root, { recursive: true, force: true });
  done();
};

main().catch((err: unknown) => {
  console.log("FAIL " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
