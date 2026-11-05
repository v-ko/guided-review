"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  checkSuggestion,
  resolve,
  applySuggestion,
} = require("../../../out/experiments/layout-suggest/suggestions.js");
const {
  renderMarkdown,
} = require("../../../out/experiments/layout-suggest/render.js");

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
});

test("whole-line spans take their Markdown markers, partial ones keep them", () => {
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

test("matching marks the longest shared word runs, deterministically and in order", async () => {
  const { matchText } =
    await import("../../../out/experiments/layout-suggest/match.mjs");
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

test("markdown renders without raw HTML, links or remote images, keeping mermaid source", () => {
  const html = renderMarkdown(`# Title

<script>alert(1)</script> [link](https://example.com) ![img](https://example.com/x.png)

\`\`\`mermaid
graph TD; A-->B
\`\`\`
`);
  assert.match(html, /<h1>Title<\/h1>/);
  assert.doesNotMatch(html, /<script>|<a |<img /);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<span class="document-link">link<\/span>/);
  assert.match(html, /<pre class="mermaid-source">graph TD; A--&gt;B\n<\/pre>/);
});
