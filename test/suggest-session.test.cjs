"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Session } = require("../out/src/suggest-session.js");

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
  await fs.writeFile(session.documentPath, "Увод. Първо, второ и трето.\n");
  assert.deepEqual(await session.wait(1, 10), []);

  // Valid suggestions are stored newest first; a broken quote is rejected.
  assert.deepEqual(
    await session.add([{ replacement: "# Бележки", after: "Няма." }]),
    {
      added: [],
      rejected: [{ index: 0, problems: ['after not found: "Няма."'] }],
    },
  );
  assert.deepEqual(await session.add([{ replacement: "Край." }]), {
    added: ["s1"],
    rejected: [],
  });
  await session.add([
    { replacement: "- Първо\n- второ\n- трето", from: "Първо", to: "трето." },
    { replacement: "## Увод", after: "Увод." },
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
  assert.equal(view.document, "doc:Увод. Първо, второ и трето.\n");
  assert.deepEqual(
    view.suggestions.map((s) => [s.id, s.html]),
    [
      ["s2", "card:- Първо\n- второ\n- трето"],
      ["s1", "card:Край."],
    ],
  );
  assert.equal(session.status().agent, "away");

  // Accepting checks the rendered view and applies the suggestion without waking the agent.
  assert.match(await session.accept("s2", "old"), /changed since/);
  assert.equal(await session.accept("s2", view.fingerprint), undefined);
  assert.equal(
    await fs.readFile(session.documentPath, "utf8"),
    "Увод.\n\n- Първо\n- второ\n- трето\n",
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
      selection: { text: "второ", source: "document" },
      selected: "s2",
      declined: ["s1"],
    }),
    undefined,
  );
  assert.deepEqual(await pending, [
    {
      type: "request",
      text: "Split this",
      selection: { text: "второ", source: "document" },
      selected: "s2",
      accepted: ["s2"],
      declined: [{ id: "s1", replacement: "Край." }],
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
