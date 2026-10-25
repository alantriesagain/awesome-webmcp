import { fetchUserName } from "./users.mjs";

export const greet = (id) => "Hello, " + fetchUserName(id) + "!";
