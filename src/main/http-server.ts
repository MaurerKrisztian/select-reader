import http from "node:http";

export interface HttpActions {
  read(text: string): void;
  stop(): void;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * A small local API so other tools (a browser extension, a script) can use the app:
 *
 *   GET http://127.0.0.1:4040/read?text=Hello
 *   GET http://127.0.0.1:4040/stop
 */
export function startHttpServer(actions: HttpActions, port = 4040): http.Server {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "OPTIONS") {
      response.writeHead(200, CORS_HEADERS).end();
      return;
    }

    if (url.pathname === "/read") {
      const text = url.searchParams.get("text");
      if (text) actions.read(text);
    } else if (url.pathname === "/stop") {
      actions.stop();
    } else {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/plain" }).end("OK");
  });

  server.on("error", (error) => {
    console.error(`Could not start the HTTP server on port ${port}: ${error.message}`);
  });
  server.listen(port, "127.0.0.1");
  return server;
}
