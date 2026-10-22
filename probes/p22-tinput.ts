// P22: bisect the native "input.changed.emit is not a function" seen in test/editor.test.ts.
import { KeyEvent, TInput, insertText } from "../packages/tdom/src/index.ts";
const input = new TInput();
console.log("1: constructed", input.tag, input.lines.length, input.changed.size);
const got: string[] = [];
input.changed.listen((v) => got.push(v));
console.log("2: listened", input.changed.size);
input.changed.emit("direct");
console.log("3: direct emit", got.join(","));
insertText(input, "a");
console.log("4: insertText", JSON.stringify(input.lines), got.join(","));
input.handleKey(new KeyEvent("char", "b", false, false, false));
console.log("5: handleKey", JSON.stringify(input.lines), got.join(","));
input.setValue("x\ny");
console.log("6: setValue", JSON.stringify(input.lines), input.row, input.col);
