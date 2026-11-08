"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  checkSuggestion,
  resolve,
  applySuggestion,
} = require("../out/src/suggestions.js");
const { renderMarkdown } = require("../out/src/suggest-render.js");

const document = `Да направя в Памет да ми предлага неща. Позволено е да променя само структурни неща - секции, булетпойнтове, разделяне в записки.

Отляво е крайната версия, отдясно предложенията.`;

function accept(text, suggestion) {
  const { span, problems } = resolve(text, suggestion);
  assert.deepEqual(problems, []);
  return applySuggestion(text, span, suggestion.replacement);
}

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
});

test("replacements, insertions and appends keep blocks apart", () => {
  // A block replacement takes the covered sentences out of their paragraph.
  const listed = accept(document, {
    replacement:
      "Позволени промени:\n\n- Секции\n- Булетпойнтове\n- Разделяне в записки",
    from: "Позволено е",
    to: "разделяне в записки.",
  });
  assert.equal(
    listed,
    `Да направя в Памет да ми предлага неща.

Позволени промени:

- Секции
- Булетпойнтове
- Разделяне в записки

Отляво е крайната версия, отдясно предложенията.`,
  );
  // Once applied, the old span is gone from the document.
  assert.match(
    resolve(listed, {
      replacement: "x",
      from: "Позволено е",
      to: "записки.",
    }).problems.join(),
    /from not found/,
  );

  // An insertion after a quote becomes its own block; an inline replacement stays inline.
  const inserted = accept("Увод. Край.", {
    replacement: "## Средата",
    after: "Увод.",
  });
  assert.equal(inserted, "Увод.\n\n## Средата\n\nКрай.");
  assert.equal(
    accept(inserted, { replacement: "Начало.", from: "Увод.", to: "Увод." }),
    "Начало.\n\n## Средата\n\nКрай.",
  );

  // Without an anchor the suggestion appends, also to an empty document.
  assert.equal(accept("", { replacement: "# Бележки" }), "# Бележки");
  assert.equal(
    accept("Текст.\n", { replacement: "- точка" }),
    "Текст.\n\n- точка\n",
  );

  // Inside a list, regrouping nested items keeps their indent and line breaks.
  const list = "|| Буфери\n  - Едно\n  - Две\n  - Три\n\n\nBuffer:\n";
  const { input } = checkSuggestion({
    replacement: "  - Група:\n    - Едно\n    - Две\n  - Три",
    from: "Едно",
    to: "Три",
  });
  assert.equal(
    accept(list, input),
    "|| Буфери\n  - Група:\n    - Едно\n    - Две\n  - Три\n\n\nBuffer:\n",
  );
  // An inserted item joins the list the same way.
  assert.equal(
    accept(list, { replacement: "  - Нова", after: "Две" }),
    "|| Буфери\n  - Едно\n  - Две\n  - Нова\n  - Три\n\n\nBuffer:\n",
  );
});

test("spans take the Markdown markers and inline markup they cover", () => {
  const text = "## Цел\n\n- Звук от телефона до десктопа.\n- Втора точка.\n";
  // A bullet's whole text becomes a paragraph, without a stray marker.
  assert.equal(
    accept(text, {
      replacement: "Звукът стига до десктопа.",
      from: "Звук",
      to: "десктопа.",
    }),
    "## Цел\n\nЗвукът стига до десктопа.\n- Втора точка.\n",
  );
  // Same for a heading, and for a block replacement starting in a bullet.
  assert.equal(
    accept(text, { replacement: "**Цел**", from: "Цел", to: "Цел" }),
    "**Цел**\n\n- Звук от телефона до десктопа.\n- Втора точка.\n",
  );
  assert.equal(
    accept(text, {
      replacement: "### Звук\n\nТелефон",
      from: "Звук",
      to: "телефона",
    }),
    "## Цел\n\n### Звук\n\nТелефон\n\nдо десктопа.\n- Втора точка.\n",
  );
  // An inline edit inside a bullet keeps the bullet.
  assert.equal(
    accept(text, { replacement: "**Звук**", from: "Звук", to: "Звук" }),
    "## Цел\n\n- **Звук** от телефона до десктопа.\n- Втора точка.\n",
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
    accept(labels, { replacement: "- Едно", after: "ADRs:" }),
    "**ADRs:**\n\n- Едно\n\n**Tech:** WebRTC, XMPP.\n",
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
  // Inside one fence the span stays, and block insertions go after the fence.
  assert.equal(
    accept(diagram, {
      replacement: "  a --> c",
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
  const text = "Едно. Две. Три. Четири. Едно.";
  const covered = (suggestion) => {
    const { span } = resolve(text, { replacement: "x", ...suggestion });
    return span && text.slice(span.start, span.end);
  };
  assert.match(
    resolve(text, {
      replacement: "x",
      from: "Едно.",
      to: "Три.",
    }).problems.join(),
    /from occurs 2 times/,
  );
  assert.match(
    resolve(text, { after: "Едно." }).problems.join(),
    /after occurs 2 times/,
  );
  assert.match(
    resolve(text, { after: "Пет." }).problems.join(),
    /after not found/,
  );
  assert.equal(covered({ from: "Две.", to: "Две." }), "Две.");
  assert.equal(covered({ from: "Три. Четири.", to: "Три." }), undefined);
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
      "Позволено е да променя само структурни неща - секции, булетпойнтове.",
      "## Позволени промени\n\nСамо структурни неща - секции:\n\n- Булетпойнтове",
    ),
    [
      ["само структурни неща - секции", "Само структурни неща - секции"],
      ["булетпойнтове", "Булетпойнтове"],
    ],
  );
  // Moved text that would cross the earlier match stays unmarked.
  assert.deepEqual(
    pairs(
      "Първо идва въведението. После следват детайлите.",
      "После следват детайлите.\n\nПърво идва въведението.",
    ),
    [["Първо идва въведението", "Първо идва въведението"]],
  );
  // Single words count only when they are long enough to be specific.
  assert.deepEqual(pairs("Ние да тръгнем", "Те да спрат"), []);
  assert.deepEqual(pairs("много структурни", "структурни промени"), [
    ["структурни", "структурни"],
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
      "Тоя мапинг е допълнителна задача, нещо удобно.",
      "Този мапинг е отделна задача; нещо удобно.",
    ),
    { removed: ["Тоя", "допълнителна", ","], added: ["Този", "отделна", ";"] },
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
