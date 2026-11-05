import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { decodeAccept, decodePrompt, type RenderMessage } from "./protocol.js";
import type { Session } from "./session.js";

const types: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Layout suggestions</title>
<link rel="stylesheet" href="/experiments/layout-suggest/page.css"></head>
<body><header class="toolbar"><strong>Layout suggestions</strong><span id="status">Connecting…</span></header>
<main><article id="document" class="markdown"></article><aside id="suggestions"></aside></main>
<form id="prompt"><div id="selection" hidden><span id="selection-source"></span><span id="selection-text"></span>
<button type="button" id="selection-clear" aria-label="Clear selection">×</button></div>
<div class="prompt-row"><input id="prompt-text" type="text" autocomplete="off" placeholder="Guide the suggestions (select text to refer to it)">
<button id="prompt-send">Send</button></div></form>
<script type="module" id="client" src="/out/experiments/layout-suggest/page.mjs"
  data-mermaid="/node_modules/mermaid/dist/mermaid.esm.min.mjs"></script></body></html>`;

const csp =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Serves the page, its assets, a server-sent event stream and the accept endpoint. */
export function createPageServer(
  session: Session,
  root: string,
  log: (line: string) => void,
): http.Server {
  // Only these directories under the package root are served.
  const assets = [
    "out/experiments/layout-suggest",
    "out/media",
    "experiments/layout-suggest",
    "node_modules/mermaid/dist",
  ].map((dir) => path.join(root, dir) + path.sep);
  const streams = new Set<http.ServerResponse>();

  async function broadcast(): Promise<void> {
    let view: RenderMessage;
    try {
      view = await session.view();
    } catch (error) {
      log(`Render failed: ${String(error)}`);
      return;
    }
    for (const stream of streams)
      stream.write(`data: ${JSON.stringify(view)}\n\n`);
  }
  session.on("change", () => void broadcast());

  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      log(`Request failed: ${String(error)}`);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const { port } = server.address() as { port: number };
    const origins = [`127.0.0.1:${port}`, `localhost:${port}`];
    // Rejects DNS rebinding and cross-site posts; the page is same-origin only.
    const origin = request.headers.origin;
    if (
      !origins.includes(request.headers.host ?? "") ||
      (origin !== undefined && !origins.some((o) => origin === `http://${o}`))
    ) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");

    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": csp,
      });
      response.end(page);
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      streams.add(response);
      request.on("close", () => streams.delete(response));
      response.write(`data: ${JSON.stringify(await session.view())}\n\n`);
      return;
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/accept" || url.pathname === "/prompt")
    ) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > 65536) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        parsed = undefined;
      }
      let error: string | undefined;
      if (url.pathname === "/accept") {
        const message = decodeAccept(parsed);
        error = message
          ? await session.accept(message.id, message.fingerprint)
          : "Malformed accept request.";
      } else {
        const message = decodePrompt(parsed);
        if (message) session.prompt(message);
        else error = "Malformed prompt.";
      }
      response.writeHead(error ? 409 : 200, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(error ? { error } : { ok: true }));
      return;
    }
    const file = path.join(root, decodeURIComponent(url.pathname));
    const type = types[path.extname(file)];
    if (
      request.method === "GET" &&
      type &&
      assets.some((dir) => file.startsWith(dir))
    ) {
      try {
        const content = await fs.promises.readFile(file);
        response.writeHead(200, { "Content-Type": type }).end(content);
        return;
      } catch {
        // Fall through to 404.
      }
    }
    response.writeHead(404).end();
  }

  return server;
}
