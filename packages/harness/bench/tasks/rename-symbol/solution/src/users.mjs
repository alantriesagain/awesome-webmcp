const USERS = { 1: "Ada", 2: "Grace", 3: "Linus" };

/** The name of user `id`, or "unknown". */
export const loadUserName = (id) => USERS[id] ?? "unknown";
