import http from "node:http";
import type { AddressInfo } from "node:net";

export interface HttpActions {
  read(text: string): void;
  togglePause(): void;
  stop(): void;
}

/** Longest request body accepted (about 1 MB of text). */
const MAX_BODY = 1_000_000;

/**
 * A small local API so other tools (a script, a browser extension) can use the app:
 *
 *   GET  http://127.0.0.1:4040/read?text=Hello
 *   POST http://127.0.0.1:4040/read      with the text as the request body
 *   GET  http://127.0.0.1:4040/pause     pause or resume
 *   GET  http://127.0.0.1:4040/stop
 *
 * Web pages can't use it (see isAllowed), otherwise any site you visit could make
 * your computer talk.
 */
export function startHttpServer(actions: HttpActions, port = 4040): http.Server {
  const server = http.createServer(async (request, response) => {
    const listening = (server.address() as AddressInfo).port; // differs from `port` when that is 0
    if (!isAllowed(request.headers, listening)) return reply(response, 403, "Requests from web pages are not allowed");

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    switch (url.pathname) {
      case "/read": {
        let text: string | null;
        try {
          text = request.method === "POST" ? await readBody(request) : url.searchParams.get("text");
        } catch {
          return reply(response, 413, "The text is too long");
        }
        if (!text?.trim()) return reply(response, 400, 'Send the text as "?text=..." or as the request body');
        actions.read(text);
        break;
      }
      case "/pause":
        actions.togglePause();
        break;
      case "/stop":
        actions.stop();
        break;
      default:
        return reply(response, 404, "Not found");
    }
    reply(response, 200, "OK");
  });

  server.on("error", (error) => {
    console.error(`Could not start the HTTP server on port ${port}: ${error.message}`);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

/**
 * Lets through requests from scripts, curl and browser extensions, but not from web
 * pages:
 * - Browsers send "Sec-Fetch-Site" with every request a page makes ("cross-site",
 *   "same-site", "same-origin"); typing the address yourself sends "none".
 * - Pages that send an Origin header are refused, unless it's a browser extension.
 * - The Host must be this computer, so a site can't point its own name at 127.0.0.1
 *   ("DNS rebinding") to look like a same-origin request.
 */
export function isAllowed(headers: http.IncomingHttpHeaders, port: number): boolean {
  if (headers.host !== `127.0.0.1:${port}` && headers.host !== `localhost:${port}`) return false;
  const origin = headers.origin;
  if (origin) return /^(chrome|moz|safari-web)-extension:\/\//.test(origin);
  const site = headers["sec-fetch-site"];
  return site === undefined || site === "none";
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (piece: string) => {
      body += piece;
      if (body.length > MAX_BODY) {
        reject(new Error("too long"));
        request.removeAllListeners("data");
        request.resume();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function reply(response: http.ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(message);
}
