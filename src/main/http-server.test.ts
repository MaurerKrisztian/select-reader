import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { isAllowed, startHttpServer } from "./http-server.js";

const calls: string[] = [];
let server: http.Server;
let port: number;

before(async () => {
  server = startHttpServer(
    {
      read: (text) => calls.push(`read:${text}`),
      togglePause: () => calls.push("pause"),
      stop: () => calls.push("stop"),
    },
    0, // any free port
  );
  await new Promise((resolve) => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => server.close());

/** Sends a request with exactly these headers (fetch() would add its own). */
function request(
  pathname: string,
  { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pathname, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = "";
        res.on("data", (piece) => (text += piece));
        res.on("end", () => resolve({ status: res.statusCode!, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("reads, pauses and stops", async () => {
  calls.length = 0;
  assert.equal((await request("/read?text=Hello%20there")).status, 200);
  assert.equal((await request("/pause")).status, 200);
  assert.equal((await request("/stop")).status, 200);
  assert.deepEqual(calls, ["read:Hello there", "pause", "stop"]);
});

test("reads the body of a POST", async () => {
  calls.length = 0;
  const text = "A long text. ".repeat(2000);
  assert.equal((await request("/read", { method: "POST", body: text })).status, 200);
  assert.deepEqual(calls, [`read:${text}`]);
});

test("asks for text when there is none", async () => {
  assert.equal((await request("/read")).status, 400);
  assert.equal((await request("/nope")).status, 404);
});

test("refuses web pages", async () => {
  calls.length = 0;
  const fromPage = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" };
  assert.equal((await request("/read?text=Hi", { headers: fromPage })).status, 403);
  assert.equal((await request("/read?text=Hi", { headers: { origin: "https://example.com" } })).status, 403);
  assert.equal((await request("/read?text=Hi", { headers: { host: `evil.example:${port}` } })).status, 403);
  assert.deepEqual(calls, []);
});

test("allows scripts, the address bar and browser extensions", () => {
  const host = "127.0.0.1:4040";
  assert.equal(isAllowed({ host }, 4040), true); // curl
  assert.equal(isAllowed({ host: "localhost:4040" }, 4040), true);
  assert.equal(isAllowed({ host, "sec-fetch-site": "none" }, 4040), true); // typed in the address bar
  assert.equal(isAllowed({ host, origin: "chrome-extension://abc", "sec-fetch-site": "cross-site" }, 4040), true);
  assert.equal(isAllowed({ host, origin: "moz-extension://abc" }, 4040), true);
  assert.equal(isAllowed({ host, "sec-fetch-site": "same-origin" }, 4040), false); // any page's own request
  assert.equal(isAllowed({ host, origin: "null" }, 4040), false); // sandboxed page
});
