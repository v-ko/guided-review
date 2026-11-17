"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  checkSuggestion,
  resolve,
  applySuggestion,
} = require("../out/src/suggestions.js");
const { renderMarkdown } = require("../out/src/suggest-render.js");

const document = `Let Pamet suggest things to me. Only structural changes are allowed - sections, bullet points, splitting into notes.

The final version is on the left, suggestions on the right.`;

function accept(text, suggestion) {
  const { span, problems } = resolve(text, suggestion);
  assert.deepEqual(problems, []);
  return applySuggestion(text, span);
}

test("structural replacements protect fences and approval pairs without reprinting other blocks", () => {
  const source = "**bold**\n\n```ts\nconst x = 1;\n```\n";
  // An insertion anchored inside a fence belongs outside it.
  const inserted = accept(source, {
    operation: "insert-block",
    after: "const x = 1;",
    replacement: "Next paragraph.",
  });
  assert.equal(inserted, source.slice(0, -1) + "\n\nNext paragraph.\n");
  // A quote within a short example replaces the entire fenced example.
  assert.equal(
    accept(source, {
      operation: "replace",
      from: "const x = 1;",
      to: "const x = 1;",
      replacement: "```ts\nconst y = 2;\n```",
    }),
    "**bold**\n\n```ts\nconst y = 2;\n```\n",
  );
  const approved =
    "Intro.\n\n```review-diff\nreference\n```\n```diff\n+recorded\n```\n\nEnd.\n";
  assert.equal(
    accept(approved, {
      operation: "replace",
      from: "reference",
      to: "reference",
      replacement: "New reference.",
    }),
    "Intro.\n\nNew reference.\n\nEnd.\n",
  );
  assert.equal(
    accept("Intro.\n```ts\nexample\n```\nOutro.", {
      operation: "replace",
      from: "example",
      to: "example",
      replacement: "Summary.",
    }),
    "Intro.\n\nSummary.\n\nOutro.",
  );
  assert.equal(
    accept("First.\r\n", {
      operation: "insert-block",
      replacement: "Inserted.",
    }),
    "First.\r\n\r\nInserted.\r\n",
  );
  assert.equal(
    accept("Keep prefix. Target start.\n\nTarget end. Keep suffix.", {
      operation: "replace",
      from: "Target start.",
      to: "Target end.",
      replacement: "Updated.",
    }),
    "Keep prefix. Updated. Keep suffix.",
  );
  // Explicit operations refuse an ambiguous end instead of choosing one.
  assert.match(
    resolve("start end end", {
      operation: "replace",
      from: "start",
      to: "end",
    }).problems.join(),
    /to occurs 2 times/,
  );
  assert.match(
    resolve(source, {
      mode: "literal",
      after: "bold",
      replacement: "x",
    }).problems.join(),
    /Legacy literal/,
  );
});

test("tool input is validated, reporting every problem", () => {
  assert.deepEqual(
    checkSuggestion({ replacement: "- a\n", from: "x", to: "y" }),
    {
      input: { replacement: "- a", from: "x", to: "y" },
      problems: [],
    },
  );
  assert.deepEqual(
    checkSuggestion({ replacement: "", from: "x", after: "z", title: "t" })
      .problems,
    [
      "Unknown field title.",
      "replacement must be a non-empty string.",
      "from and to go together.",
      "Use either from/to or after, not both.",
    ],
  );
  assert.deepEqual(
    checkSuggestion({ replacement: "b", from: "x", to: "y", kind: "edit" }),
    {
      input: { replacement: "b", from: "x", to: "y", kind: "edit" },
      problems: [],
    },
  );
  // layout is the default and is not stored.
  assert.deepEqual(
    checkSuggestion({ replacement: "b", kind: "layout" }).input,
    { replacement: "b" },
  );
  assert.deepEqual(
    checkSuggestion({ replacement: "b", kind: "edit" }).problems,
    ["An edit needs from/to: it rewords existing text."],
  );
  assert.deepEqual(
    checkSuggestion({ replacement: "b", kind: "fix" }).problems,
    ["kind must be layout or edit."],
  );
  assert.deepEqual(
    checkSuggestion({ replacement: "b", mode: "literal", preview: "tableRows" })
      .problems,
    ["Unknown field mode.", "Unknown field preview."],
  );
});

test("structural insertions keep table rows and list siblings in their containers", () => {
  const table =
    "| Name | Meaning |\r\n| --- | --- |\r\n| Queue | Pending |\r\n\r\nEnd.\r\n";
  const row = {
    operation: "insert-table-rows",
    after: "Name",
    replacement: "| Store | Saved |",
  };
  const inserted = accept(table, row);
  assert.equal(
    inserted,
    table.replace("| --- | --- |", "| --- | --- |\r\n| Store | Saved |"),
  );
  assert.deepEqual(resolve(table, row).span.target, {
    startLine: 0,
    endLine: 1,
    structural: true,
  });
  assert.equal(
    accept(inserted, { ...row, after: "Queue" }),
    inserted.replace(
      "| Queue | Pending |",
      "| Queue | Pending |\r\n| Store | Saved |",
    ),
  );
  assert.match(
    resolve(table, {
      ...row,
      replacement: "| Too | Many | Cells |",
    }).problems.join(),
    /2 columns/,
  );

  // Insert after the parent and its children, using its markers rather than the payload's.
  const list = "Intro.\n\n3) Parent\n   - Child\n4) Next\n\nEnd.\n";
  const siblings = {
    operation: "insert-list-items",
    after: "Parent",
    replacement: "- Added\n- Another",
  };
  assert.equal(
    accept(list, siblings),
    list.replace("   - Child", "   - Child\n4) Added\n5) Another"),
  );
  assert.equal(
    accept(list, {
      ...siblings,
      after: "Child",
      replacement: "1. Nested sibling",
    }),
    list.replace("   - Child", "   - Child\n   - Nested sibling"),
  );
  assert.match(
    resolve(list, {
      ...siblings,
      replacement: "- Parent\n  - Nested",
    }).problems.join(),
    /single-line sibling/,
  );
  assert.match(
    resolve("> - Quoted\n", { ...siblings, after: "Quoted" }).problems.join(),
    /outside block quotes/,
  );
  assert.match(
    resolve("- - Inner\n  - Next\n- Outer\n", {
      ...siblings,
      after: "Inner",
    }).problems.join(),
    /Same-line nested list targets/,
  );
});

test("replacements, insertions and appends keep blocks apart", () => {
  // A block replacement takes the covered sentences out of their paragraph.
  const listed = accept(document, {
    replacement:
      "Allowed changes:\n\n- Sections\n- Bullet points\n- Splitting into notes",
    from: "Only structural",
    to: "splitting into notes.",
  });
  assert.equal(
    listed,
    `Let Pamet suggest things to me.

Allowed changes:

- Sections
- Bullet points
- Splitting into notes

The final version is on the left, suggestions on the right.`,
  );
  // Once applied, the old span is gone from the document.
  assert.match(
    resolve(listed, {
      replacement: "x",
      from: "Only structural",
      to: "notes.",
    }).problems.join(),
    /from not found/,
  );

  // An insertion after a quote becomes its own block; an inline replacement stays inline.
  const inserted = accept("Intro. End.", {
    replacement: "## Middle",
    after: "Intro.",
  });
  assert.equal(inserted, "Intro.\n\n## Middle\n\nEnd.");
  assert.equal(
    accept(inserted, { replacement: "Start.", from: "Intro.", to: "Intro." }),
    "Start.\n\n## Middle\n\nEnd.",
  );

  // Without an anchor the suggestion appends, also to an empty document.
  assert.equal(accept("", { replacement: "# Notes" }), "# Notes");
  assert.equal(
    accept("Text.\n", { replacement: "- item" }),
    "Text.\n\n- item\n",
  );

  // Inside a list, regrouping nested items keeps their indent and line breaks.
  const list = "|| Buffers\n  - One\n  - Two\n  - Three\n\n\nBuffer:\n";
  const { input } = checkSuggestion({
    replacement: "  - Group:\n    - One\n    - Two\n  - Three",
    from: "One",
    to: "Three",
  });
  assert.equal(
    accept(list, input),
    "|| Buffers\n  - Group:\n    - One\n    - Two\n  - Three\n\n\nBuffer:\n",
  );
  // An inserted item joins the list the same way.
  assert.equal(
    accept(list, {
      operation: "insert-list-items",
      replacement: "  - New",
      after: "Two",
    }),
    "|| Buffers\n  - One\n  - Two\n  - New\n  - Three\n\n\nBuffer:\n",
  );
});

test("spans take the Markdown markers and inline markup they cover", () => {
  const text = "## Goal\n\n- Audio from phone to desktop.\n- Second item.\n";
  // A bullet's whole text becomes a paragraph, without a stray marker.
  assert.equal(
    accept(text, {
      replacement: "Audio reaches the desktop.",
      from: "Audio",
      to: "desktop.",
    }),
    "## Goal\n\nAudio reaches the desktop.\n- Second item.\n",
  );
  // Same for a heading, and for a block replacement starting in a bullet.
  assert.equal(
    accept(text, { replacement: "**Goal**", from: "Goal", to: "Goal" }),
    "**Goal**\n\n- Audio from phone to desktop.\n- Second item.\n",
  );
  assert.equal(
    accept(text, {
      replacement: "### Audio\n\nPhone",
      from: "Audio",
      to: "phone",
    }),
    "## Goal\n\n### Audio\n\nPhone\n\nto desktop.\n- Second item.\n",
  );
  // An inline edit inside a bullet keeps the bullet.
  assert.equal(
    accept(text, { replacement: "**Audio**", from: "Audio", to: "Audio" }),
    "## Goal\n\n- **Audio** from phone to desktop.\n- Second item.\n",
  );

  // Quotes cross inline markup, and spans take the markup they would cut through.
  const labels = "**ADRs:**\n\n**Tech:** WebRTC, XMPP.\n";
  assert.equal(
    accept(labels, { replacement: "## ADRs", from: "ADRs:", to: "ADRs:" }),
    "## ADRs\n\n**Tech:** WebRTC, XMPP.\n",
  );
  assert.equal(
    accept(labels, {
      replacement: "Tech: *WebRTC*",
      from: "Tech: WebRTC",
      to: "WebRTC",
    }),
    "**ADRs:**\n\nTech: *WebRTC*, XMPP.\n",
  );
  assert.equal(
    accept(labels, { replacement: "- One", after: "ADRs:" }),
    "**ADRs:**\n\n- One\n\n**Tech:** WebRTC, XMPP.\n",
  );

  // A span that cuts a code fence takes the whole block, so no lone fence opens a code block to the end.
  const diagram =
    "Intro.\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\n## Next\n";
  assert.equal(
    accept(diagram, {
      replacement: "Overview.",
      from: "Intro.",
      to: "a --> b",
    }),
    "Overview.\n\n## Next\n",
  );
  assert.equal(
    accept(diagram, { replacement: "## Graph", from: "a --> b", to: "Next" }),
    "Intro.\n\n## Graph\n",
  );
  // Replacements inside a fence take the whole example; insertions go after it.
  assert.equal(
    accept(diagram, {
      replacement: "```mermaid\nflowchart LR\n  a --> c\n```",
      from: "a --> b",
      to: "a --> b",
    }),
    "Intro.\n\n```mermaid\nflowchart LR\n  a --> c\n```\n\n## Next\n",
  );
  assert.equal(
    accept(diagram, { replacement: "- Note", after: "flowchart LR" }),
    "Intro.\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\n- Note\n\n## Next\n",
  );
});

test("quotes must be unambiguous and the span covers the whole from quote", () => {
  const text = "One. Two. Three. Four. One.";
  const covered = (suggestion) => {
    const { span } = resolve(text, { replacement: "x", ...suggestion });
    return span && text.slice(span.start, span.end);
  };
  assert.match(
    resolve(text, {
      replacement: "x",
      from: "One.",
      to: "Three.",
    }).problems.join(),
    /from occurs 2 times/,
  );
  assert.match(
    resolve(text, { after: "One." }).problems.join(),
    /after occurs 2 times/,
  );
  assert.match(
    resolve(text, { after: "Five." }).problems.join(),
    /after not found/,
  );
  assert.equal(covered({ from: "Two.", to: "Two." }), "Two.");
  assert.equal(covered({ from: "Three. Four.", to: "Three." }), undefined);
});

test("the page finds every quote the host resolves, in rendered text", async () => {
  const { findQuote } = await import("../out/media/match.mjs");
  const source =
    "Intro with **bold words** and `code`.\n\n```\nFiles: `src/a.ts` (now in section 3), `b.json`.\n```\n";
  const { html } = await renderMarkdown(
    source,
    { documentPath: "/tmp/x.md", allowed: async () => false },
    false,
  );
  // The page indexes rendered text; code blocks keep their backticks.
  const rendered = html.replace(/<[^>]+>/g, "").replace(/&#96;/g, "`");
  for (const quote of [
    "with bold words and code.",
    "Files: src/a.ts (now in section 3), b.json.",
  ]) {
    assert.ok(resolve(source, { after: quote }).span, quote);
    assert.ok(findQuote(rendered, quote, 0), quote);
  }
});

test("matching marks the longest shared word runs, deterministically and in order", async () => {
  const { matchText } = await import("../out/media/match.mjs");
  function pairs(source, target) {
    return matchText(source, target).map((m) => [
      source.slice(...m.source),
      target.slice(...m.target),
    ]);
  }
  // Punctuation and Markdown syntax inside a sentence do not break a run;
  // sentence ends and block breaks split it into separately coloured pieces.
  assert.deepEqual(
    pairs(
      "We may change only structural things - sections, bullets.",
      "## Allowed changes\n\nOnly structural things - sections:\n\n- Bullets",
    ),
    [
      [
        "only structural things - sections",
        "Only structural things - sections",
      ],
      ["bullets", "Bullets"],
    ],
  );
  // Moved text that would cross the earlier match stays unmarked.
  assert.deepEqual(
    pairs(
      "First comes the introduction. Then follow the details.",
      "Then follow the details.\n\nFirst comes the introduction.",
    ),
    [["First comes the introduction", "First comes the introduction"]],
  );
  // Single words count only when they are long enough to be specific.
  assert.deepEqual(pairs("We may go", "They may stop"), []);
  assert.deepEqual(pairs("many structural", "structural changes"), [
    ["structural", "structural"],
  ]);
});

test("edit diffs mark what changed, merging adjacent changes", async () => {
  const { diffText } = await import("../out/media/match.mjs");
  function parts(source, target) {
    const { removed, added } = diffText(source, target);
    return {
      removed: removed.map((r) => source.slice(...r)),
      added: added.map((r) => target.slice(...r)),
    };
  }
  assert.deepEqual(
    parts(
      "That mapping is an additional task, something convenient.",
      "This mapping is an independent task; something convenient.",
    ),
    {
      removed: ["That", "additional", ","],
      added: ["This", "independent", ";"],
    },
  );
  // Neighbouring changed words form one range; case changes count.
  assert.deepEqual(parts("a b c d", "a X Y d"), {
    removed: ["b c"],
    added: ["X Y"],
  });
  assert.deepEqual(parts("Same text", "same text"), {
    removed: ["Same"],
    added: ["same"],
  });
  assert.deepEqual(parts("one two", "one two"), { removed: [], added: [] });
});

test("markdown renders without raw HTML, links or remote images, keeping mermaid source", async () => {
  const { html } = await renderMarkdown(
    `# Title

<script>alert(1)</script> [link](https://example.com) ![img](https://example.com/x.png)

\`\`\`mermaid
graph TD; A-->B
\`\`\`
`,
    { documentPath: "/tmp/x.md", allowed: async () => false },
    false,
  );
  assert.match(html, /<h1>Title<\/h1>/);
  assert.doesNotMatch(html, /<script>|<a |<img /);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<span class="document-link">link<\/span>/);
  assert.match(html, /<pre class="mermaid-source">graph TD; A--&gt;B\n<\/pre>/);
});
