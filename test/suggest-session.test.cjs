"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Session } = require("../out/src/suggest-session.js");
const { decodePageMessage } = require("../out/src/suggest-protocol.js");
const { renderMarkdown } = require("../out/src/suggest-render.js");

test("headerless row suggestions survive reload, render safely and accept as exact source", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "guided-review-rows-"));
  const documents = {
    render: async (markdown, documentPath, approvable, preview) =>
      (
        await renderMarkdown(
          markdown,
          { documentPath, allowed: async () => false },
          approvable,
          preview,
        )
      ).html,
    outdated: async () => [],
    unsaved: () => false,
  };
  const session = new Session(dir, documents);
  t.after(async () => {
    session.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await session.start();
  const row = "| Session | Store | Similar responsibilities |";
  const source =
    "| GR | Sivkit | Comparison |\n| --- | --- | --- |\n" + row + "\n";
  await fs.writeFile(session.documentPath, source);
  const replacement =
    "\n| **Queue** | `a\\|b` | <script>bad()</script> |\n| [Link](https://example.com) | ![img](https://example.com/x.png) | More |";

  // Invalid row hints are refused before saving; acceptance never gets a disguised paragraph.
  const rejected = await session.add([
    { replacement: "ordinary paragraph", preview: "tableRows" },
    { replacement: "| a | b |\n| c |", preview: "tableRows" },
    { replacement: "| a | b |\n| --- | --- |", preview: "tableRows" },
    {
      replacement: "| a | b |\r| --- | --- |\r| c | d | HIDDEN |",
      preview: "tableRows",
    },
  ]);
  assert.equal(rejected.rejected.length, 4);
  assert.ok(
    rejected.rejected.every(({ problems }) =>
      problems.join().includes("tableRows"),
    ),
  );
  assert.deepEqual(await session.list(), []);
  assert.deepEqual(
    await session.add([
      { mode: "literal", after: row, replacement, preview: "tableRows" },
    ]),
    { added: ["s1"], rejected: [] },
  );
  session.close();

  // Reload preserves source, metadata and row-only rendering with the normal safety rules.
  const restored = new Session(dir, documents);
  t.after(() => restored.close());
  await restored.start();
  const [saved] = await restored.list({ includeContent: true });
  assert.equal(saved.replacement, replacement);
  assert.equal(saved.mode, "literal");
  assert.equal(saved.preview, "tableRows");
  const view = await restored.view();
  const html = view.suggestions[0].html;
  assert.equal((html.match(/<tr>/g) ?? []).length, 2);
  assert.equal((html.match(/<td>/g) ?? []).length, 6);
  assert.doesNotMatch(html, /<thead>|<th>|<script>|<a |<img /);
  assert.match(html, /<strong>Queue<\/strong>/);
  assert.match(html, /<code>a\|b<\/code>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<span class="document-link">Link<\/span>/);

  // Accept inserts only the exact proposed bytes and produces a single valid document table.
  assert.equal(await restored.accept("s1", view.fingerprint), undefined);
  assert.equal(
    await restored.readDocument(),
    source.replace(row, row + replacement),
  );
  const accepted = await restored.view();
  assert.equal((accepted.document.match(/<table>/g) ?? []).length, 1);
  assert.equal((accepted.document.match(/<tr>/g) ?? []).length, 4);
});

test("pending suggestions can be recovered with exact Markdown and inspected without mutation", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "guided-review-inspect-"),
  );
  const documents = {
    render: async (markdown) => markdown,
    outdated: async () => [],
    unsaved: () => false,
  };
  const session = new Session(dir, documents);
  t.after(async () => {
    session.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await session.start();
  await fs.writeFile(session.documentPath, "Notes.\n");
  const replacement =
    "## Exact Markdown\n\n```ts\nconst value = '<tag>';\n```\n";
  await session.add([{ replacement }, { replacement: "Another proposal." }]);

  // Recover persisted proposals, keeping exact source rather than rendered HTML.
  const restored = new Session(dir, documents);
  await restored.start();
  t.after(() => restored.close());
  const before = await restored.view();
  const full = await restored.list({ includeContent: true });
  assert.equal(full[0].replacement, replacement.trim());
  assert.deepEqual(
    await restored.list({ ids: ["s2", "s1"], includeContent: true }),
    full,
  );
  assert.deepEqual(await restored.list({ ids: ["s1"], includeContent: true }), [
    full[0],
  ]);
  assert.deepEqual(await restored.list({ ids: [] }), []);
  await assert.rejects(
    restored.list({ ids: ["s1", "missing"] }),
    /Unknown suggestion ids: missing/,
  );

  // Compact and full results agree except for content; neither affects acceptance.
  assert.deepEqual(
    await restored.list(),
    full.map(({ replacement, ...summary }) => summary),
  );
  assert.equal((await restored.view()).fingerprint, before.fingerprint);
  assert.equal(await restored.accept("s1", before.fingerprint), undefined);
  assert.match(await restored.readDocument(), /const value = '<tag>';/);
  await assert.rejects(
    restored.list({ ids: ["s1"] }),
    /Unknown suggestion ids/,
  );
});
test("reader requests can be answered with comments or suggestions without changing the document", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "guided-review-comments-"),
  );
  const documents = {
    render: async (markdown) => markdown,
    outdated: async () => [],
    unsaved: () => false,
  };
  const session = new Session(dir, documents);
  t.after(async () => {
    session.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await session.start();
  await fs.writeFile(session.documentPath, "Notes.\n");
  await session.add([{ replacement: "More notes." }]);
  const before = await session.view();
  await session.accept("s1", before.fingerprint);
  await session.add([{ replacement: "Keep this suggestion." }]);

  // The same request includes selection and suggestion feedback whichever answer the agent chooses.
  const request = decodePageMessage({
    type: "request",
    id: "c1",
    text: "Why?",
    call: 2,
    selection: { text: "Notes.", source: "document" },
    declined: ["s2"],
  });
  const waiting = session.wait("comment", 30_000);
  await session.request(request);
  assert.deepEqual(await waiting, [
    {
      type: "request",
      text: "Why?",
      selection: { text: "Notes.", source: "document" },
      accepted: ["s1"],
      declined: [{ id: "s2", replacement: "Keep this suggestion." }],
    },
  ]);
  const document = await session.readDocument();
  const suggestions = await session.list();
  await assert.rejects(session.respondToComment(" "), /needs text/);
  await session.respondToComment("**Because.**");
  assert.equal((await session.view()).comment.html, "**Because.**");
  assert.equal(await session.readDocument(), document);
  assert.deepEqual(await session.list(), suggestions);

  // Another request can receive suggestions instead; only a new reply replaces the bubble.
  await session.request({ type: "request", id: "c2", text: "And then?" });
  await session.wait("next-comment", 100);
  await session.add([{ replacement: "Then we continue." }]);
  assert.equal((await session.view()).comment.html, "**Because.**");
  await session.respondToComment("Then we continue.");
  const savedComment = (await session.view()).comment;
  const restored = new Session(dir, documents);
  await restored.start();
  try {
    assert.deepEqual((await restored.view()).comment, savedComment);
  } finally {
    restored.close();
  }

  // Withdrawal still uses internal delivery IDs and leaves the last reply intact.
  await session.request({ type: "request", id: "c3", text: "Never mind." });
  await session.withdraw("c3");
  assert.equal(session.status().pending, undefined);
  assert.deepEqual((await session.view()).comment, savedComment);
});

test("accepts and declines ride on the reader's request, which wakes a pending wait", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "layout-suggest-"));
  const outdated = [];
  let unsaved = false;
  const session = new Session(path.join(dir, "notes"), {
    render: async (markdown, _path, approvable) =>
      `${approvable ? "doc" : "card"}:${markdown}`,
    outdated: async () => outdated,
    unsaved: () => unsaved,
  });
  t.after(async () => {
    session.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await session.start();
  assert.equal(session.name, "notes");
  await fs.writeFile(session.documentPath, "Intro. First, second and third.\n");
  assert.deepEqual(await session.wait(1, 10), []);

  // Valid suggestions are stored newest first; a broken quote is rejected.
  assert.deepEqual(
    await session.add([{ replacement: "# Notes", after: "Missing." }]),
    {
      added: [],
      rejected: [{ index: 0, problems: ['after not found: "Missing."'] }],
    },
  );
  assert.deepEqual(await session.add([{ replacement: "End." }]), {
    added: ["s1"],
    rejected: [],
  });
  await session.add([
    { replacement: "- First\n- second\n- third", from: "First", to: "third." },
    { replacement: "## Intro", after: "Intro." },
  ]);
  assert.deepEqual(
    (await session.list()).map((s) => s.id),
    ["s2", "s3", "s1"],
  );
  assert.deepEqual(await session.remove(["s3", "s9"]), {
    removed: ["s3"],
    unknown: ["s9"],
  });

  // The page gets the document and cards rendered apart; the timed-out wait left no agent.
  const view = await session.view();
  assert.equal(view.document, "doc:Intro. First, second and third.\n");
  assert.deepEqual(
    view.suggestions.map((s) => [s.id, s.html]),
    [
      ["s2", "card:- First\n- second\n- third"],
      ["s1", "card:End."],
    ],
  );
  assert.equal(session.status().agent, "away");

  // Accepting checks the rendered view and applies the suggestion without waking the agent.
  assert.match(await session.accept("s2", "old"), /changed since/);
  assert.equal(await session.accept("s2", view.fingerprint), undefined);
  assert.equal(
    await fs.readFile(session.documentPath, "utf8"),
    "Intro.\n\n- First\n- second\n- third\n",
  );
  assert.deepEqual(await session.wait(2, 10), []);

  // A request reports the accept, the declines and outdated code blocks since the last one.
  const pending = session.wait(3, 30_000);
  assert.equal(session.status().agent, "listening");
  outdated.push({ id: "parse", file: "src/cli.ts", problems: ["No match."] });
  assert.equal(
    await session.request({
      type: "request",
      id: "r1",
      text: "Split this",
      selection: { text: "second", source: "document" },
      selected: "s2",
      declined: ["s1"],
    }),
    undefined,
  );
  assert.deepEqual(await pending, [
    {
      type: "request",
      text: "Split this",
      selection: { text: "second", source: "document" },
      selected: "s2",
      accepted: ["s2"],
      declined: [{ id: "s1", replacement: "End." }],
      outdated: [{ id: "parse", file: "src/cli.ts", problems: ["No match."] }],
    },
  ]);
  outdated.length = 0;
  assert.deepEqual(await session.list(), []);
  assert.deepEqual(
    [session.status().agent, session.status().delivered],
    ["working", "r1"],
  );

  // Without a waiting agent, one request stays queued until withdrawn.
  await session.request({ type: "request", id: "r3", text: "Later" });
  assert.match(
    await session.request({ type: "request", id: "r4" }),
    /Another request/,
  );
  assert.equal(session.status().pending.text, "Later");
  assert.equal(await session.withdraw("r3"), undefined);
  assert.equal(await session.withdraw("r3"), "No such request.");
  assert.deepEqual(await session.wait(4, 10), []);

  // Once delivered, a request cannot be withdrawn; a cancelled wait does not consume the next one.
  await session.request({ type: "request", id: "r5" });
  assert.deepEqual(await session.wait(5, 10), [{ type: "request" }]);
  assert.match(await session.withdraw("r5"), /already picked up/);
  const cancelled = session.wait(6, 30_000);
  session.cancel(6);
  assert.deepEqual(await cancelled, []);

  // The session can work on an existing Markdown file, editing it in place.
  const notes = path.join(dir, "plan.md");
  await fs.writeFile(notes, "Plan.\n");
  assert.match(await session.setDocument("plan.md"), /absolute path/);
  assert.equal(await session.setDocument(notes), undefined);
  assert.equal(session.documentPath, await fs.realpath(notes));
  await session.add([{ replacement: "# Plan", from: "Plan.", to: "Plan." }]);
  const notesView = await session.view();
  // Unsaved changes in an editor block the write.
  unsaved = true;
  assert.match(
    await session.accept(notesView.suggestions[0].id, notesView.fingerprint),
    /unsaved/,
  );
  assert.equal(await fs.readFile(notes, "utf8"), "Plan.\n");
  unsaved = false;
  await session.accept(notesView.suggestions[0].id, notesView.fingerprint);
  assert.equal(await fs.readFile(notes, "utf8"), "# Plan\n");

  // A restarted session finds its document again.
  const again = new Session(session.dir, session.documents);
  await again.start();
  again.close();
  assert.equal(again.documentPath, await fs.realpath(notes));
});
