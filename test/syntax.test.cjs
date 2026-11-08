"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { liveDiff } = require("../out/src/spans.js");
const {
  renderMarkdown,
  setApproval,
  parseBlocks,
} = require("../out/src/suggest-render.js");
const { resolve, applySuggestion } = require("../out/src/suggestions.js");
const {
  SyntaxHighlighter,
  readTheme,
  themedOverrides,
} = require("../out/src/syntax.js");

test("theme includes, JSONC, TextMate styles and scoped customizations are composited", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "guided-code-review-syntax-"),
  );
  try {
    await fs.writeFile(
      path.join(root, "base.json"),
      '{ // colors\n"colors":{"editor.foreground":"#eeeeee"}, "tokenColors":[{"scope":"string","settings":{"foreground":"#123456"}}],}',
    );
    await fs.writeFile(
      path.join(root, "theme.json"),
      JSON.stringify({
        include: "base.json",
        tokenColors: [
          {
            scope: "comment",
            settings: { foreground: "#654321", fontStyle: "italic" },
          },
        ],
      }),
    );
    const theme = await readTheme(path.join(root, "theme.json"));
    assert.equal(theme.settings.length, 2);
    assert.equal(theme.colors["editor.foreground"], "#eeeeee");
    const customized = themedOverrides(
      {
        textMateRules: [{ scope: "global" }],
        "[Other]": { strings: "#111111" },
        "[Test*]": { comments: "#222222" },
        "[Test Dark][Test Light]": { textMateRules: [{ scope: "specific" }] },
      },
      ["Test Dark"],
    );
    assert.equal(customized.strings, undefined);
    assert.equal(customized.comments, "#222222");
    assert.deepEqual(
      customized.textMateRules.map((rule) => rule.scope),
      ["global", "specific"],
    );
    await fs.writeFile(
      path.join(root, "cycle.json"),
      '{"include":"cycle.json"}',
    );
    await assert.rejects(readTheme(path.join(root, "cycle.json")), /Cyclic/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("TextMate recovers from a cold timeout and keeps approved excerpts colored and frozen", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "guided-code-review-grammar-"),
  );
  let highlighter;
  try {
    await fs.writeFile(
      path.join(root, "grammar.json"),
      JSON.stringify({
        scopeName: "source.test",
        patterns: [
          { name: "comment.block.test", begin: "/\\*", end: "\\*/" },
          { name: "string.quoted.test", begin: '"', end: '"' },
          { name: "keyword.control.test", match: "\\breturn\\b" },
        ],
      }),
    );
    await fs.writeFile(
      path.join(root, "theme.json"),
      JSON.stringify({
        colors: { "editor.foreground": "#cccccc" },
        tokenColors: [
          {
            scope: "comment",
            settings: { foreground: "#123456", fontStyle: "italic" },
          },
          { scope: "string", settings: { foreground: "#654321" } },
          { scope: "keyword", settings: { foreground: "#abcdef" } },
        ],
      }),
    );
    const configuration = {
      workbench: { colorTheme: "Test Dark" },
      editor: {},
      files: {},
      guidedCodeReview: {},
    };
    const vscode = {
      extensions: {
        all: [
          {
            extensionPath: root,
            packageJSON: {
              contributes: {
                languages: [{ id: "test", extensions: [".test"] }],
                grammars: [
                  {
                    language: "test",
                    scopeName: "source.test",
                    path: "grammar.json",
                  },
                ],
                themes: [
                  { id: "Test Dark", label: "Test Dark", path: "theme.json" },
                ],
              },
            },
          },
        ],
      },
      workspace: {
        getConfiguration: (section) => ({
          get: (key, fallback) => configuration[section][key] ?? fallback,
        }),
      },
    };
    highlighter = new SyntaxHighlighter(vscode);
    await highlighter.initialize();
    assert.ok(highlighter.registry, "The fixture theme must load.");
    const grammar = await highlighter.registry.loadGrammar("source.test");
    assert.ok(grammar);
    // A cold multiline line times out once; retry must use its original incoming state.
    const tokenize = grammar.tokenizeLine2.bind(grammar);
    let coldState;
    let retried = false;
    grammar.tokenizeLine2 = (text, state, limit) => {
      if (text === "old <script>" && coldState === undefined) {
        coldState = state;
        return {
          tokens: new Uint32Array(),
          ruleStack: state,
          stoppedEarly: true,
        };
      }
      if (text === "old <script>" && !retried) {
        assert.equal(state, coldState);
        retried = true;
      }
      return tokenize(text, state, limit);
    };
    const before = '/*\nold <script>\n*/\nreturn "old";';
    const after = '/*\nnew <script>\n*/\nreturn "new";';
    const wanted = new Set([2, 4]);
    const highlight = async () => ({
      before: await highlighter.highlightLines("file.test", before, wanted),
      after: await highlighter.highlightLines("file.test", after, wanted),
    });
    const first = await highlight();
    assert.ok(retried, "A transient timeout must not discard the excerpt.");
    assert.match(first.before.get(2), /color:#123456.*font-style:italic/);
    assert.match(first.after.get(2), /color:#123456.*new &lt;script&gt;/);
    assert.match(first.after.get(4), /color:#ABCDEF/i);
    assert.match(first.after.get(4), /color:#654321/);
    for (const side of [first.before, first.after])
      for (const html of side.values()) assert.doesNotMatch(html, /<script>/);
    assert.deepEqual(
      [...first.after.values()].map((html) => html.replace(/<[^>]+>/g, "")),
      ["new &lt;script&gt;", "return &quot;new&quot;;"],
    );
    configuration.editor.tokenColorCustomizations = {
      "[Test*]": { comments: "#fedcba", strings: "#987654" },
    };
    highlighter.invalidate();
    const changed = await highlight();
    assert.match(changed.after.get(2), /#FEDCBA/i);
    assert.match(changed.after.get(4), /#987654/);

    // Render a real live diff, then embed approval and edit the working file again.
    const git = (...args) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await fs.writeFile(path.join(root, "file.test"), before);
    git("add", "file.test");
    git("commit", "-qm", "base");
    await fs.writeFile(path.join(root, "file.test"), after);
    const diff = await liveDiff(root, "file.test");
    const ref = {
      id: "example",
      repo: ".",
      file: "file.test",
      spans: [diff.span([0, diff.lines.length - 1])],
    };
    const markdown = `\`\`\`review-diff\n${JSON.stringify(ref)}\n\`\`\`\n`;
    const context = {
      documentPath: path.join(root, "notes.md"),
      allowed: async () => true,
      highlight: (file, text, wanted) =>
        highlighter.highlightLines(file, text, wanted),
    };
    const live = await renderMarkdown(markdown, context, true);
    assert.match(live.html, /syntax-token/);
    const approved = setApproval(markdown, ref.id, live.blocks[0].groups);
    const frozen = (await renderMarkdown(approved, context, true)).html;
    assert.match(frozen, /color:#FEDCBA[^>]*>new &lt;script&gt;/i);
    assert.match(frozen, /color:#987654/i);
    // An insertion after the JSON belongs after its approval record, as its marker shows.
    const insertion = {
      after: JSON.stringify(ref),
      replacement: "Next section.",
    };
    const { span, problems } = resolve(approved, insertion);
    assert.deepEqual(problems, []);
    const extended = applySuggestion(approved, span, insertion.replacement);
    assert.ok(parseBlocks(extended).blocks[0].approved);
    assert.ok(extended.indexOf("Next section.") > extended.lastIndexOf("```"));
    // A replacement crossing the two fences must take both original boundaries.
    const replacement = {
      from: JSON.stringify(ref),
      to: 'return "new";',
      replacement: "Reviewed summary.",
    };
    const replacedSpan = resolve(approved, replacement);
    assert.deepEqual(replacedSpan.problems, []);
    assert.equal(
      applySuggestion(
        approved,
        replacedSpan.span,
        replacement.replacement,
      ).trim(),
      "Reviewed summary.",
    );
    await fs.writeFile(path.join(root, "file.test"), 'return "later";');
    const reread = (await renderMarkdown(approved, context, true)).html;
    assert.match(reread, /syntax-token/);
    assert.match(reread, /new &lt;script&gt;/);
    assert.doesNotMatch(reread, /later/);
    const unsupported = await highlighter.lines(
      "unknown.bin",
      after,
      new Set([2]),
      Infinity,
    );
    assert.equal(unsupported.size, 0);
    const tooLong = await highlighter.lines(
      "file.test",
      "x".repeat(10001),
      new Set([1]),
      Infinity,
    );
    assert.equal(tooLong.size, 0);
    configuration.guidedCodeReview.syntaxHighlighting = false;
    assert.equal(
      (await highlighter.highlightLines("file.test", after, wanted)).size,
      0,
    );
  } finally {
    highlighter?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("disposal drains active initialization but prevents queued and later highlighting", async () => {
  const configuration = { get: (_key, fallback) => fallback };
  const highlighter = new SyntaxHighlighter({
    workspace: { getConfiguration: () => configuration },
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  let initialized = 0;
  let disposed = 0;
  highlighter.initialize = async () => {
    initialized++;
    started();
    await gate;
    highlighter.registry = {
      dispose() {
        disposed++;
      },
    };
  };
  const active = highlighter.highlightLines("a.test", "a", new Set([1]));
  const queued = highlighter.highlightLines("a.test", "a", new Set([1]));
  await entered;
  highlighter.dispose();
  const later = highlighter.highlightLines("a.test", "a", new Set([1]));
  release();
  const outputs = await Promise.all([active, queued, later]);
  await new Promise(setImmediate);
  assert.ok(outputs.every((output) => output.size === 0));
  assert.equal(initialized, 1);
  assert.equal(disposed, 1);
});
