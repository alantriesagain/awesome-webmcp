import { readFileSync } from "node:fs";
import { defaults } from "./defaults.mjs";

/** The settings: the defaults, then what `file` sets. */
export const loadConfig = (file) => {
  const settings = { ...defaults };
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (raw.environment !== undefined) settings.environment = raw.environment;
  if (raw.currencyCode !== undefined) settings.currency = raw.currencyCode;
  if (raw.locale !== undefined) settings.locale = raw.locale;
  return settings;
};
