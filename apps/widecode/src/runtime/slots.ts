// The function slots a plugin fills for the core. The prelude passes a list, the runtime reads it
// by position; this is the one order both sides name. A slot left out is -1.
export const PANEL_SLOTS = ["count", "rows", "info", "width", "press", "infoPress", "shown", "badge", "hidden"];
export const AGENT_SLOTS = [
  "start",
  "send",
  "interrupt",
  "setMode",
  "setModel",
  "setEffort",
  "respond",
  "resume",
  "reset",
  "stop",
  "kill",
  "loadEarlier",
  "receive",
  "sessions",
  "loadSubagent",
  "withdraw",
  "sideQuestion",
];

/** `name`'s place in `slots`. */
export const slotOf = (slots: string[], name: string): number => {
  for (let i = 0; i < slots.length; i++) if (slots[i] === name) return i;
  return -1;
};
