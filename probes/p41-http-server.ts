// An HTTP server on 127.0.0.1 at a port the system picks, as widecode's MCP server runs one: a POST
// whose JSON body is answered with JSON, one answered later as an event stream written in parts
// (held open while a timer runs), a request refused for its token, then the server closed. The
// client is node:http in the same program.
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";

const TOKEN = "t0k3n";

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => {
    chunks.push(c);
  });
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.headers["authorization"] !== "Bearer " + TOKEN) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("no");
      return;
    }
    const msg = JSON.parse(body) as { id?: unknown; method?: unknown };
    if (msg.method === "slow") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let n = 0;
      const tick = (): void => {
        n++;
        if (n < 3) {
          res.write("event: message\ndata: " + JSON.stringify({ progress: n }) + "\n\n");
          setTimeout(tick, 30);
          return;
        }
        res.end("event: message\ndata: " + JSON.stringify({ id: msg.id, result: "late" }) + "\n\n");
      };
      setTimeout(tick, 30);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    const text = "" + JSON.stringify({ id: msg.id, method: msg.method, url: req.url, verb: req.method });
    res.end(text);
  });
});

const post = (port: number, token: string, body: string): Promise<string> =>
  new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" } }, (res: IncomingMessage) => {
      const parts: string[] = [];
      res.on("data", (c: Buffer) => {
        parts.push(c.toString("utf8"));
      });
      res.on("end", () => resolve(String(res.statusCode) + " " + String(res.headers["content-type"]) + " " + parts.join("").replace(/\n/g, "|")));
    });
    req.on("error", (e: Error) => resolve("error " + e.message));
    req.end(body);
  });

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  console.log("listening on a port: " + String(port > 0));
  const run = async (): Promise<void> => {
    console.log(await post(port, TOKEN, '{"id":1,"method":"ping"}'));
    console.log(await post(port, TOKEN, '{"id":2,"method":"slow"}'));
    console.log(await post(port, "wrong", '{"id":3,"method":"ping"}'));
    server.close(() => console.log("closed"));
  };
  run();
});
