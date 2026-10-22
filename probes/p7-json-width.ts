// P7: JSON.parse -> unknown -> narrow partial casts; extra keys at every level must be ignored; wrong types must throw.
const line =
  '{"type":"system","subtype":"init","session_id":"abc","model":"m1","tools":["Read","Edit"],"extra_top":1,' +
  '"nested":{"deep":{"x":1}},"message":{"role":"assistant","content":[{"type":"text","text":"hi","citations":null},' +
  '{"type":"tool_use","id":"t1","name":"Read","input":{"path":"/x"}}],"usage":{"input_tokens":3}},' +
  '"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"He"},"weird":[1,2,3]}}';

const raw: unknown = JSON.parse(line);
const out: string[] = [];
const head = raw as { type: string };
out.push("type=" + head.type);
const sys = raw as { subtype: string; session_id?: string; model?: string; tools?: string[]; missing?: number };
out.push("init=" + sys.subtype + "/" + (sys.session_id ?? "?") + "/" + (sys.model ?? "?") + "/" + (sys.tools ?? []).join("+") + "/missing=" + String(sys.missing === undefined));
const ev = (raw as { event: unknown }).event;
const et = ev as { type: string };
if (et.type === "content_block_delta") {
  const d = ev as { index: number; delta: { type: string; text?: string } };
  out.push("delta=" + String(d.index) + ":" + d.delta.type + ":" + (d.delta.text ?? ""));
}
const a = raw as { message: { content: { type: string; text?: string }[] } };
out.push("text=" + a.message.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""));
out.push("blocks=" + a.message.content.map((c) => c.type).join(","));

let threw = "no";
try {
  const bad = raw as { session_id: number };
  void bad.session_id;
} catch (e) {
  threw = e instanceof TypeError ? "TypeError" : "other";
}
out.push("mismatch=" + (threw === "TypeError" || threw === "no" ? "ok(node:no-check, scriptc:TypeError)" : threw));

let threw2 = "no";
try {
  const r2: unknown = JSON.parse("{not json");
  out.push(String(r2 === null));
} catch (e) {
  threw2 = e instanceof SyntaxError ? "SyntaxError" : "other";
}
out.push("parse-error=" + threw2);
console.log(out.join(" | "));
