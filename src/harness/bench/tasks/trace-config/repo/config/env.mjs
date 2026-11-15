/** The environment names people type, and the profile each one means. */
const aliases = { stage: "staging", prod: "production", dev: "development" };

/** The profile for an environment name. */
export const profileFor = (name) => aliases[name] ?? name;
