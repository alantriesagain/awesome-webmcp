import { loadUserName } from "./users.mjs";

export const greet = (id) => "Hello, " + loadUserName(id) + "!";
