import { loadSettings } from "../config/load.mjs";

const settings = loadSettings(process.env);
console.log("worker ready: queue=" + settings.queue + " environment=" + settings.environment);
