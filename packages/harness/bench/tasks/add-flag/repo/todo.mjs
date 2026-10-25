// A tiny todo list: `node todo.mjs list` prints each todo as "[x] 1 title".
const TODOS = [
  { id: 1, title: "write the plan", done: true },
  { id: 2, title: "build it", done: false },
  { id: 3, title: "measure it", done: false },
];

const [command] = process.argv.slice(2);
if (command === "list") {
  for (const t of TODOS) console.log((t.done ? "[x] " : "[ ] ") + String(t.id) + " " + t.title);
} else {
  console.log("usage: node todo.mjs list");
  process.exit(2);
}
