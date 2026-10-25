import { load } from "./config/load.mjs";

const settings = load(process.env, process.argv.slice(2));
console.log("would listen on " + settings.host + ":" + String(settings.port));
