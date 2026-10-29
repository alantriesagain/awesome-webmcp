/**
 * @file The desktop harness's page: the transcript, the composer and the status line as one
 * light component, fed by the backend's events and sending turns through the bridge. Mirrors
 * apps/harness/src/app.ts, the terminal screen, with the browser's own text box.
 */
import View from "@lightstart/light";
import titleBar from "@lightstart/light/components/app/title-bar.js";
import { html, key } from "@lightstart/light/html";
import { connect } from "@lightstart/light/native/desktop/client.js";

/** @import { HarnessApi, HarnessEvents } from "../contract.ts" */
/** @typedef {{ id: number, role: string, text: string }} Message */

/** @type {import("@lightstart/light/native/desktop/types.ts").Desktop<HarnessApi, HarnessEvents>} */
const desktop = connect();
let nextId = 1;

View.define("lc-title-bar", titleBar);

View.define("harness-app", {
  props: {
    /** @type {Message[]} */
    messages: [],
    state: "idle",
    model: "",
    session: "",
    turns: 0,
    costUsd: 0,
    note: "",
  },
  async connected() {
    desktop.on("init", (e) => {
      this.model = e.model;
      this.session = e.sessionId;
    });
    desktop.on("delta", (e) => this.append(e.text));
    desktop.on("assistant", (e) => {
      if (e.text.length > 0) this.replaceLast(e.text);
    });
    desktop.on("result", (e) => {
      this.state = e.isError ? "error" : "idle";
      this.turns = e.numTurns;
      this.costUsd = e.costUsd;
      this.note = e.isError ? e.subtype + (e.errors.length > 0 ? ": " + e.errors : "") : "";
      const last = this.messages[this.messages.length - 1];
      if (last !== undefined && last.role === "assistant" && last.text.length === 0 && e.result.length > 0) this.replaceLast(e.result);
      desktop.log("info", "saw result");
    });
    desktop.on("status", (e) => {
      if (e.subtype === "status" && e.status.length > 0) this.note = e.status;
    });
    desktop.on("stderr", (e) => {
      this.note = e.text.slice(0, 80);
    });
    desktop.on("error", (e) => {
      this.state = "error";
      this.note = e.message;
    });
    desktop.on("exit", (e) => {
      this.state = "exited";
      this.note = "claude exited with code " + String(e.code);
    });
    await desktop.ready();
    const info = await desktop.call.session();
    if (info.model.length > 0) this.model = info.model;
    if (info.selftest) this.add("user", "Reply with exactly: PONG");
    if (info.selftest) this.add("assistant", "");
  },
  /**
   * @param {string} role
   * @param {string} text
   */
  add(role, text) {
    this.messages = this.messages.concat([{ id: nextId++, role, text }]);
    this.scrollDown();
  },
  /** @param {string} text */
  append(text) {
    const last = this.messages[this.messages.length - 1];
    if (last === undefined || last.role !== "assistant") return;
    this.replaceLast(last.text + text);
  },
  /** @param {string} text */
  replaceLast(text) {
    const last = this.messages[this.messages.length - 1];
    if (last === undefined) return;
    this.messages = this.messages.slice(0, -1).concat([{ id: last.id, role: last.role, text }]);
    this.scrollDown();
  },
  scrollDown() {
    const log = this.querySelector(".log");
    if (log !== null) requestAnimationFrame(() => log.scrollTo(0, log.scrollHeight));
  },
  /** @param {KeyboardEvent} e */
  async keydown(e) {
    if (e.key !== "Enter" || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const box = /** @type {HTMLTextAreaElement} */ (e.target);
    const text = box.value.trim();
    if (text.length === 0) return;
    box.value = "";
    this.add("user", text);
    this.add("assistant", "");
    this.state = "streaming";
    const r = await desktop.call.send(text);
    if (!r.started) {
      this.state = "error";
      this.note = "cannot start claude: " + r.error;
    }
  },
  left() {
    const st = this.state;
    const mark = st === "streaming" ? "…" : st === "idle" ? "●" : "○";
    return mark + " " + st + (this.model.length > 0 ? "  " + this.model : "") + (this.session.length > 0 ? "  " + this.session.slice(0, 8) : "");
  },
  right() {
    /** @type {string[]} */
    const parts = [];
    if (this.turns > 0) parts.push("turns " + String(this.turns));
    if (this.costUsd > 0) parts.push("$" + this.costUsd.toFixed(4));
    if (this.note.length > 0) parts.push(this.note);
    return parts.join("  ");
  },
  render() {
    return html`
      <lc-title-bar></lc-title-bar>
      <div class="log">
        ${this.messages.map((m) => key(m.id, html`<div class="message ${m.role}"><b>${m.role === "user" ? "You" : "Claude"}</b><p>${m.text}</p></div>`))}
      </div>
      <div class="composer">
        <label>You</label>
        <textarea placeholder="Write here. Enter sends, Shift+Enter adds a line." @keydown=${this.keydown}></textarea>
      </div>
      <div class="status"><span>${this.left()}</span><span>${this.right()}</span></div>`;
  },
});
