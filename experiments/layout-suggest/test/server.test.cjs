"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const main = path.resolve(
  __dirname,
  "../../../out/experiments/layout-suggest/main.js",
);

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          // Server-sent events never end; the first event is enough.
          if (url.endsWith("/events") && body.includes("\n\n")) {
            response.destroy();
            resolve({ response, body });
          }
        });
        response.on("end", () => resolve({ response, body }));
      })
      .on("error", reject);
  });
}

function post(url, value) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode, body: JSON.parse(body) }),
        );
      },
    );
    request.on("error", reject);
    request.end(JSON.stringify(value));
  });
}

test("the page accepts a suggestion and a pending MCP long poll reports it", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "layout-suggest-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const documentPath = path.join(dir, "document.md");
  await fs.writeFile(documentPath, "Увод. Първо, второ и трето.\n");

  const child = spawn(process.execPath, [main], {
    env: { ...process.env, LAYOUT_SUGGEST_DIR: dir, LAYOUT_SUGGEST_PORT: "0" },
  });
  t.after(() => child.kill());
  const page = await new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const found = /page: (\S+)/.exec(stderr);
      if (found) resolve(found[1]);
    });
    child.on("exit", (code) => reject(new Error(`exit ${code}: ${stderr}`)));
  });

  const replies = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let end; (end = buffer.indexOf("\n")) !== -1;) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      replies.get(message.id)?.(message);
    }
  });
  let nextId = 0;
  function call(method, params) {
    const id = ++nextId;
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    return new Promise((resolve) => replies.set(id, resolve));
  }
  async function tool(name, args = {}) {
    const reply = await call("tools/call", { name, arguments: args });
    return JSON.parse(reply.result.content[0].text);
  }
  const waitForFeedback = (seconds) =>
    tool("wait_for_feedback", { timeout_seconds: seconds });

  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.match(init.result.instructions, /read-only for you/);
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  const tools = await call("tools/list", {});
  assert.deepEqual(
    tools.result.tools.map((tool) => tool.name),
    [
      "wait_for_feedback",
      "add_suggestions",
      "remove_suggestions",
      "list_suggestions",
      "clear_session",
    ],
  );
  assert.equal((await call("nope", {})).error.code, -32601);
  assert.deepEqual((await waitForFeedback(1)).events, []);

  // Valid suggestions are stored newest first; a broken quote is rejected.
  assert.deepEqual(
    await tool("add_suggestions", {
      suggestions: [{ replacement: "# Бележки", after: "Няма." }],
    }),
    {
      added: [],
      rejected: [{ index: 0, problems: ['after not found: "Няма."'] }],
    },
  );
  assert.deepEqual(
    await tool("add_suggestions", {
      suggestions: [{ replacement: "Край." }],
    }),
    { added: ["s1"], rejected: [] },
  );
  await tool("add_suggestions", {
    suggestions: [
      { replacement: "- Първо\n- второ\n- трето", from: "Първо", to: "трето." },
      { replacement: "## Увод", after: "Увод." },
    ],
  });
  assert.deepEqual(
    (await tool("list_suggestions")).map((s) => s.id),
    ["s2", "s3", "s1"],
  );
  assert.deepEqual(await tool("remove_suggestions", { ids: ["s3", "s9"] }), {
    removed: ["s3"],
    unknown: ["s9"],
  });

  const home = await get(page);
  assert.equal(home.response.statusCode, 200);
  assert.match(
    home.response.headers["content-security-policy"],
    /default-src 'none'/,
  );
  const { port } = new URL(page);
  assert.equal(
    (await get(page, { Host: `attacker.example:${port}` })).response.statusCode,
    403,
  );
  assert.equal((await get(`${page}out/src/host.js`)).response.statusCode, 404);
  assert.equal(
    (await get(`${page}out/experiments/layout-suggest/page.mjs`)).response
      .statusCode,
    200,
  );

  const events = await get(`${page}events`);
  const view = JSON.parse(events.body.replace(/^data: /, ""));
  assert.deepEqual(
    view.suggestions.map((s) => [s.id, s.problems]),
    [
      ["s2", []],
      ["s1", []],
    ],
  );
  assert.match(view.suggestions[0].html, /<li>второ<\/li>/);

  const pending = waitForFeedback(30);
  const stale = await post(`${page}accept`, {
    type: "accept",
    id: "s2",
    fingerprint: "old",
  });
  assert.equal(stale.status, 409);
  const accepted = await post(`${page}accept`, {
    type: "accept",
    id: "s2",
    fingerprint: view.fingerprint,
  });
  assert.deepEqual(accepted, { status: 200, body: { ok: true } });

  const feedback = await pending;
  assert.deepEqual(feedback.events, [{ type: "accepted", id: "s2" }]);
  assert.equal(feedback.document, documentPath);
  assert.deepEqual(
    feedback.suggestions.map((s) => s.id),
    ["s1"],
  );
  assert.equal(
    await fs.readFile(documentPath, "utf8"),
    "Увод.\n\n- Първо\n- второ\n- трето\n",
  );

  // A prompt with the reader's selection is queued until the agent polls.
  const prompt = {
    type: "prompt",
    text: "Split this",
    selection: { text: "второ", source: "document" },
  };
  assert.deepEqual(await post(`${page}prompt`, prompt), {
    status: 200,
    body: { ok: true },
  });
  assert.equal(
    (await post(`${page}prompt`, { type: "prompt", text: " " })).status,
    409,
  );
  assert.deepEqual((await waitForFeedback(1)).events, [prompt]);

  // Clearing empties the document and suggestions and drops feedback about the old text.
  await post(`${page}prompt`, prompt);
  await call("tools/call", { name: "clear_session", arguments: {} });
  assert.equal(await fs.readFile(documentPath, "utf8"), "");
  assert.deepEqual(await tool("list_suggestions"), []);
  assert.deepEqual((await waitForFeedback(1)).events, []);
});
