import { defaults } from "./defaults.mjs";

/** The settings: the defaults, TLS moving the port up by 363 unless one is given, then the environment and the flags. */
export const load = (env, argv) => {
  const s = { ...defaults };
  if (s.tls && env.PORT === undefined && !argv.includes("--port")) s.port = s.port + 363;
  if (env.PORT !== undefined) s.port = Number(env.PORT);
  const at = argv.indexOf("--port");
  if (at >= 0) s.port = Number(argv[at + 1]);
  return s;
};
