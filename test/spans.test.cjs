"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  liveDiff,
  rangeCores,
  uncoveredCores,
  blockLines,
  captureInspection,
  stageCores,
  staged,
} = require("../out/src/spans.js");
const {
  renderMarkdown,
  setApproval,
  navigationTargets,
} = require("../out/src/suggest-render.js");

const base = `# header
import sys


def parse(argv):
    opts = {}
    return opts
`;

test("split blocks find their lines across edits and stage working intermediate states", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "layout-suggest-spans-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const file = path.join(root, "cli.py");
  const write = (text) => fs.writeFile(file, text);
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await write(base);
  git("add", "cli.py");
  git("commit", "-qm", "base");
  await write(
    base
      .replace("{}", "defaults()")
      .replace("return opts", "return validate(opts)"),
  );

  // One change, split into two blocks of one removed and one added line each.
  let diff = await liveDiff(root, "cli.py");
  const capture = (ranges) => {
    const { cores, problems } = rangeCores(diff, ranges);
    assert.deepEqual(problems, []);
    return { cores, spans: cores.map((core) => diff.span(core)) };
  };
  const a = capture(["old:6", "6"]);
  const b = capture(["old:7", "7"]);
  // A working line range takes the line it replaces, not the next replacement's.
  assert.deepEqual(rangeCores(diff, ["6"]).cores, [
    [a.cores[0][0], a.cores[1][1]],
  ]);
  // Coverage: what block a does not show is exactly block b's lines.
  assert.deepEqual(uncoveredCores(diff, a.cores), [
    [b.cores[0][0], b.cores.at(-1)[1]],
  ]);

  // Block a shows its own lines in the order approval stages them; b's removed line stays as context, b's added line is hidden.
  const shown = (spans, cores) =>
    blockLines(
      diff,
      spans.map((span, k) => ({
        start: cores[k][0] - span.before,
        length: span.before + span.lines + span.after,
      })),
      cores,
    ).map((group) => group.map((line) => line.kind + line.text));
  assert.deepEqual(shown(a.spans, a.cores), [
    [
      " ",
      " ",
      " def parse(argv):",
      "-    opts = {}",
      "+    opts = defaults()",
      "     return opts",
    ],
  ]);

  // A failed revalidation stages nothing.
  await assert.rejects(
    stageCores(diff, a.cores, async () => {
      throw new Error("stale view");
    }),
    /stale view/,
  );
  assert.equal(git("show", ":cli.py"), base);

  // Approving a alone stages a working intermediate state.
  await stageCores(diff, a.cores, async () => {});
  assert.equal(git("show", ":cli.py"), base.replace("{}", "defaults()"));
  assert.deepEqual(
    [await staged(diff, a.cores), await staged(diff, b.cores)],
    [true, false],
  );
  await stageCores(diff, b.cores, async () => {});
  assert.equal(git("show", ":cli.py"), await fs.readFile(file, "utf8"));

  // An edit far above moves the lines; the spans still find them.
  await write("#!/usr/bin/env python\n" + (await fs.readFile(file, "utf8")));
  diff = await liveDiff(root, "cli.py");
  const moved = diff.locate(a.spans[1]);
  assert.equal(diff.lines[moved.core[0]].text, "    opts = defaults()");
  assert.equal(diff.lines[moved.core[0]].new, 7);

  // Changing a's line makes a outdated and, as context, b too.
  await write(
    (await fs.readFile(file, "utf8")).replace("defaults()", "load_defaults()"),
  );
  diff = await liveDiff(root, "cli.py");
  assert.match(diff.locate(a.spans[1]).problem, /changed or was committed/);
  assert.match(diff.locate(b.spans[0]).problem, /changed or was committed/);

  // Approving a again replaces its staged line and keeps b's, though git joins them in one change.
  const again = capture(["old:6", "7"]);
  await stageCores(diff, again.cores, async () => {});
  assert.equal(
    git("show", ":cli.py"),
    base
      .replace("{}", "load_defaults()")
      .replace("return opts", "return validate(opts)"),
  );

  // The document shows the block live, embeds what approval staged, and flags it once unstaged.
  const documentPath = path.join(root, "notes.md");
  const block = {
    id: "defaults",
    repo: ".",
    file: "cli.py",
    spans: again.spans,
  };
  const markdown = `# Notes\n\n\`\`\`review-diff\n${JSON.stringify(block)}\n\`\`\`\n`;
  const context = { documentPath, allowed: async () => true };
  const live = await renderMarkdown(markdown, context, true);
  const inspection = captureInspection(diff, again.spans, again.cores);
  assert.deepEqual(
    inspection.preview.map(({ head, omittedLines, tail }) => {
      assert.equal(omittedLines, 0);
      return [...head, ...tail];
    }),
    live.blocks[0].groups,
    "Capture previews must match the actual block, including intermediate-state context.",
  );
  assert.match(live.html, /data-action="approve"/);
  assert.match(live.html, /load_defaults\(\)/);
  const approved = setApproval(markdown, "defaults", live.blocks[0].groups);
  assert.match(approved, /```review-diff\n.*\n```\n```diff\n@@\n/);
  assert.match(
    (await renderMarkdown(approved, context, true)).html,
    /Approved &amp; staged/,
  );
  const targets = navigationTargets(live.blocks[0]);
  assert.equal(targets.length, again.spans.length);
  assert.equal(
    new Set(targets.map((target) => target.id)).size,
    targets.length,
  );
  assert.deepEqual(
    navigationTargets(
      (await renderMarkdown(approved, context, true)).blocks[0],
    ),
    targets,
    "Approval retains navigation only while the frozen excerpt matches its live target.",
  );
  const movedDocument = await fs.readFile(file, "utf8");
  await write("# moved\n" + movedDocument);
  const relocated = navigationTargets(
    (await renderMarkdown(approved, context, true)).blocks[0],
  );
  assert.equal(relocated[1].id, targets[1].id);
  assert.equal(relocated[1].next[0], targets[1].next[0] + 1);
  await write(movedDocument.replace("load_defaults()", "unrelated()"));
  const staleApproved = await renderMarkdown(approved, context, true);
  assert.deepEqual(navigationTargets(staleApproved.blocks[0]), []);
  assert.match(staleApproved.html, /Original location unavailable/);
  await write(movedDocument);
  git("reset", "-q", "cli.py");
  assert.match(
    (await renderMarkdown(approved, context, true)).html,
    /no longer staged[\s\S]*data-action="unapprove"|data-action="unapprove"[\s\S]*no longer staged/,
  );
  assert.equal(setApproval(approved, "defaults", undefined), markdown);

  // Two blocks that insert at the same place stage apart, in either order.
  git("reset", "-q", "cli.py");
  await write(
    base.replace(
      "    return opts",
      "    log(opts)\n    check(opts)\n    return opts",
    ),
  );
  diff = await liveDiff(root, "cli.py");
  const log = capture(["7"]);
  const check = capture(["8"]);
  await stageCores(diff, check.cores, async () => {});
  await stageCores(diff, log.cores, async () => {});
  assert.equal(git("show", ":cli.py"), await fs.readFile(file, "utf8"));
  assert.deepEqual(
    [await staged(diff, log.cores), await staged(diff, check.cores)],
    [true, true],
  );

  // A deletion is not staged while the index holds a different replacement for its line.
  await write(base.replace("    opts = {}\n", ""));
  diff = await liveDiff(root, "cli.py");
  const removal = capture(["old:6"]);
  git("reset", "-q", "cli.py");
  const index = (text) => {
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: text,
      encoding: "utf8",
    }).trim();
    git("update-index", "--cacheinfo", `100644,${blob},cli.py`);
  };
  index(base.replace("{}", "other()"));
  assert.equal(await staged(diff, removal.cores), false);
  await stageCores(diff, removal.cores, async () => {});
  assert.equal(git("show", ":cli.py"), await fs.readFile(file, "utf8"));
  assert.equal(await staged(diff, removal.cores), true);

  // Other staged changes next to a block, with no clear order against it, refuse staging.
  index(base.replace("parse(argv)", "parse(args)").replace("{}", "other()"));
  await assert.rejects(
    stageCores(diff, removal.cores, async () => {}),
    /other changes/,
  );

  // A wide capture must not turn separated edits into one misleading jump.
  await write(
    base.replace("import sys", "import os").replace("{}", "defaults()"),
  );
  diff = await liveDiff(root, "cli.py");
  const wide = capture(["2-6"]);
  assert.equal(wide.cores.length, 1);
  const wideMarkdown = `\`\`\`review-diff\n${JSON.stringify({ ...block, spans: wide.spans })}\n\`\`\`\n`;
  const separated = navigationTargets(
    (await renderMarkdown(wideMarkdown, context, true)).blocks[0],
  );
  assert.deepEqual(
    separated.map((target) => target.next),
    [
      [2, 2],
      [6, 6],
    ],
  );
});

test("capture inspection exposes cut declarations and abbreviates previews without expanding staging", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "layout-suggest-inspection-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  const source = [
    "export function selected() {",
    ...Array.from({ length: 20 }, (_, index) => `  work(${index});`),
    `  return "${"x".repeat(700)}";`,
    "}",
    "",
    "export function next() {",
    "  return 2;",
    "}",
  ];
  await fs.writeFile(path.join(root, "example.ts"), source.join("\n") + "\n");
  const diff = await liveDiff(root, "example.ts");
  const capture = (range) => {
    const { cores, problems } = rangeCores(diff, [range]);
    assert.deepEqual(problems, []);
    const spans = cores.map((core) => diff.span(core));
    return { cores, spans, inspection: captureInspection(diff, spans, cores) };
  };

  // A mistaken range starts inside one function and includes the next declaration.
  const wrong = capture("2-25");
  assert.equal(wrong.inspection.boundaries[0].first.text, source[1]);
  assert.equal(wrong.inspection.boundaries[0].last.text, source[24]);
  assert.equal(wrong.inspection.boundaries[0].preceding.at(-1).text, source[0]);
  assert.equal(wrong.inspection.boundaries[0].following[0].text, source[25]);

  // Recapture the whole intended function; omitted lines and characters are explicit.
  const correct = capture("1-23");
  const { head, tail, omittedLines } = correct.inspection.preview[0];
  assert.equal(head.length + tail.length, 16);
  assert.equal(omittedLines, 7);
  assert.equal(tail.at(-1).text, "}");
  const long = tail.find((line) => line.new === 22);
  assert.equal(long.text, source[21].slice(0, 500));
  assert.equal(long.omittedCharacters, source[21].length - 500);
  assert.equal(
    correct.inspection.boundaries[0].following.at(-1).text,
    source[25],
  );
  assert.ok(![...head, ...tail].some((line) => line.text === source[24]));

  // Inspection writes nothing; approving still stages only the literal captured core.
  assert.equal(git("ls-files"), "");
  await stageCores(diff, correct.cores, async () => {});
  assert.equal(
    git("show", ":example.ts"),
    source.slice(0, 23).join("\n") + "\n",
  );
});
