/** The codename of each Node.js release line that reached LTS status, by major version. */
const CODENAMES = { 14: "Fermium", 16: "Gallium", 18: "Hydrogen", 20: "Iron", 22: "Jod" };

/** The LTS codename of Node.js `major`, or undefined when that line has not reached LTS status. */
export const codename = (major) => CODENAMES[major];

/** The newest line with LTS status. */
export const newestLts = () => Math.max(...Object.keys(CODENAMES).map(Number));
