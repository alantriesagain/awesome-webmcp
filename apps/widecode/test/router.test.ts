// The excerpt a host call's arguments are logged with when they are not JSON: its length, and
// for a long one its first and last 200 characters, so the log names the call without carrying it.
// The Settings instance is what gives the native build of the router's import graph a concrete
// state file; without it scriptc refuses the API's virtual call through the abstract StateFile.
import { argsExcerpt } from "../src/runtime/router.ts";
import { Settings } from "@light/kernel/settings.ts";
import { done, eq, ok } from "@light/test/assert.ts";

const settings = new Settings();
ok("the settings the router imports have a concrete state file", settings.section("router.test") === null);

eq("an empty string", argsExcerpt(""), "an empty string");

const short = '{"a":1}';
eq("a short one: its length and the whole string, quoted", argsExcerpt(short), String(short.length) + " characters: " + JSON.stringify(short));

const long = "a".repeat(200) + "m".repeat(600) + "z".repeat(200);
const excerpt = argsExcerpt(long);
ok("a long one says its length", excerpt.startsWith("1000 characters: "));
ok("and holds its first 200 characters", excerpt.includes(JSON.stringify(long.slice(0, 200))));
ok("and its last 200", excerpt.includes(JSON.stringify(long.slice(800))));
ok("but not the middle", !excerpt.includes("mmm"));

done();
