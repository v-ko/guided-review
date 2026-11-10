import MarkdownIt from "markdown-it";

/**
 * layout restructures the text it covers and is shown by matching what it keeps;
 * edit rewords it and is shown as a word diff.
 */
export type SuggestionKind = "layout" | "edit";
export type SuggestionOperation =
  "replace" | "insert-block" | "insert-list-items" | "insert-table-rows";

/**
 * An agent suggestion. The anchor is from+to (replace that span), after
 * (insert a block after a quote) or neither (append to the document end).
 */
export interface SuggestionInput {
  replacement: string;
  from?: string;
  to?: string;
  after?: string;
  /** Absent means layout. */
  kind?: SuggestionKind;
  operation?: SuggestionOperation;
}

export interface Suggestion extends SuggestionInput {
  id: string;
  /** Retained only to expose legacy proposals as unappliable, never reinterpret them. */
  mode?: string;
  preview?: string;
}

export interface Span {
  start: number;
  end: number;
}

export interface EditPlan extends Span {
  replacement: string;
  /** Zero-based source lines identifying the rendered destination. */
  target: { startLine: number; endLine: number; structural?: boolean };
}

export interface Resolution {
  span?: EditPlan;
  problems: string[];
}

const fields = ["replacement", "from", "to", "after"] as const;
const kinds: readonly string[] = ["layout", "edit"];
const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

/** Parses headerless rows as table cells, with no synthetic header in the result. */
export function parseTableRows(markdown: string): ReturnType<typeof md.parse> {
  const rows = markdown.split(/\r\n?|\n/);
  while (rows.length && !rows[0].trim()) rows.shift();
  while (rows.length && !rows.at(-1)!.trim()) rows.pop();
  if (!rows.length)
    throw new Error("insert-table-rows needs at least one pipe-table row.");
  let width: number | undefined;
  const parsed = rows.map((row) => {
    // This only sizes the delimiter; markdown-it decides whether the row is valid.
    const cells = row.trim().split(/(?<!\\)\|/);
    if (cells[0] === "") cells.shift();
    if (cells.at(-1) === "") cells.pop();
    const delimiter = `|${cells.map(() => "---").join("|")}|`;
    const tokens = md.parse(`${row}\n${delimiter}`, {});
    const columns = tokens.filter((token) => token.type === "th_open").length;
    if (
      !row.includes("|") ||
      cells.every((cell) => /^:?-+:?$/.test(cell.trim())) ||
      tokens[0]?.type !== "table_open" ||
      tokens.at(-1)?.type !== "table_close" ||
      !columns ||
      (width !== undefined && columns !== width)
    )
      throw new Error(
        "insert-table-rows needs only non-empty pipe-table rows with the same number of columns; omit headers and delimiter rows.",
      );
    width = columns;
    for (const token of tokens) {
      if (token.type === "th_open" || token.type === "th_close") {
        token.type = token.type.replace("th_", "td_");
        token.tag = "td";
      } else if (token.type === "thead_open" || token.type === "thead_close") {
        token.type = token.type.replace("thead_", "tbody_");
        token.tag = "tbody";
      }
    }
    return tokens;
  });
  return [
    ...parsed[0].slice(0, 2),
    ...parsed.flatMap((tokens) => tokens.slice(2, -2)),
    ...parsed[0].slice(-2),
  ];
}

// What may precede a plain-text quote on its line: indentation, >, list items, task boxes, headings.
const blockMarkers =
  /^[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)*$/;
const operations: readonly string[] = [
  "replace",
  "insert-block",
  "insert-list-items",
  "insert-table-rows",
];

/** Validates untrusted tool input, reporting every problem at once. */
export function checkSuggestion(value: unknown): {
  input?: SuggestionInput;
  problems: string[];
} {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { problems: ["Suggestion must be an object."] };
  const record = value as Record<string, unknown>;
  const problems = Object.keys(record)
    .filter(
      (key) =>
        !["kind", "operation"].includes(key) &&
        !(fields as readonly string[]).includes(key),
    )
    .map((key) => `Unknown field ${key}.`);
  const input: Partial<SuggestionInput> = {};
  for (const field of fields) {
    const text = record[field];
    if (text === undefined && field !== "replacement") continue;
    if (typeof text === "string" && text.trim())
      // The replacement keeps the first line's indent, which nests list items.
      input[field] =
        field === "replacement"
          ? text.replace(/^\s*\n/, "").trimEnd()
          : text.trim();
    else problems.push(`${field} must be a non-empty string.`);
  }
  const has = (field: string) => record[field] !== undefined;
  if (has("from") !== has("to")) problems.push("from and to go together.");
  if (has("after") && (has("from") || has("to")))
    problems.push("Use either from/to or after, not both.");
  if (has("operation")) {
    if (
      typeof record.operation !== "string" ||
      !operations.includes(record.operation)
    )
      problems.push(`operation must be ${operations.join(", ")}.`);
    else {
      input.operation = record.operation as SuggestionOperation;
      if (record.operation === "replace" && !has("from"))
        problems.push("replace needs from/to.");
      if (record.operation !== "replace" && has("from"))
        problems.push("Insertion operations use after, not from/to.");
      if (
        ["insert-list-items", "insert-table-rows"].includes(record.operation) &&
        !has("after")
      )
        problems.push(`${record.operation} needs after.`);
    }
  }
  if (has("kind")) {
    if (typeof record.kind !== "string" || !kinds.includes(record.kind))
      problems.push("kind must be layout or edit.");
    else if (record.kind === "edit" && !has("from"))
      problems.push("An edit needs from/to: it rewords existing text.");
    else if (record.kind === "edit") input.kind = "edit";
  }
  if (record.operation === "insert-table-rows") {
    if (input.replacement !== undefined) {
      try {
        parseTableRows(input.replacement);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        problems.push(error.message);
      }
    }
  }
  if (problems.length) return { problems };
  if (input.replacement === undefined)
    throw new Error("Validated suggestion is missing replacement.");
  return { input: { ...input, replacement: input.replacement }, problems };
}
function occurrences(text: string, quote: string, from = 0): Span[] {
  const found: Span[] = [];
  for (
    let start = text.indexOf(quote[0], from);
    start !== -1;
    start = text.indexOf(quote[0], start + 1)
  ) {
    const end = matchAt(text, start, quote);
    if (end !== undefined) found.push({ start, end });
  }
  return found;
}

// Inline Markdown that quotes leave out: emphasis, code and strikethrough runs, link brackets and targets, escapes.
const markup = /[*_~`]+|\[|\]\([^)\n]*\)|\\(?=[!-/:-@[-`{-~])/y;
const markupTokens = /[*_~`]+|\[|\]\([^)\n]*\)/g;

/** End of the quote matched at start in the source, skipping markup between its characters. */
function matchAt(
  text: string,
  start: number,
  quote: string,
): number | undefined {
  let i = start;
  for (let j = 0; j < quote.length;) {
    if (text[i] === quote[j]) {
      i++;
      j++;
      continue;
    }
    markup.lastIndex = i;
    if (!markup.test(text)) return undefined;
    i = markup.lastIndex;
  }
  return i;
}

const mirror = (run: string) => [...run].reverse().join("");

/** Widens a span so it does not cut through emphasis, code or link markup. */
function balance(text: string, span: Span): Span {
  let { start, end } = span;
  for (;;) {
    const before = /(?:[*_~`]+|\[)$/.exec(text.slice(0, start))?.[0] ?? "";
    const after = /[*_~`]+|\]\([^)\n]*\)/y.exec(text.slice(end))?.[0] ?? "";
    const inside = text.slice(start, end).match(markupTokens) ?? [];
    const count = (run: string) =>
      inside.filter((token) =>
        run === "[" || run.startsWith("](")
          ? token === "[" || token.startsWith("](")
          : token === run || token === mirror(run),
      ).length;
    const pair =
      before &&
      (before === "[" ? after.startsWith("](") : after === mirror(before));
    const takeBefore = before && (pair || count(before) % 2 === 1);
    const takeAfter = after && (pair || count(after) % 2 === 1);
    if (!takeBefore && !takeAfter) return { start, end };
    if (takeBefore) start -= before.length;
    if (takeAfter) end += after.length;
  }
}

function unique(document: string, quote: string, name: string): Span | string {
  const found = occurrences(document, quote);
  if (found.length === 1) return found[0];
  return found.length
    ? `${name} occurs ${found.length} times, use a longer quote: "${quote}"`
    : `${name} not found: "${quote}"`;
}

function structure(document: string) {
  const lines = document.split(/\r\n|\r|\n/);
  const offsets = [0];
  for (const match of document.matchAll(/\r\n|\r|\n/g))
    offsets.push(match.index + match[0].length);
  const tokens = md.parse(document, {});
  const endOfLine = (line: number) =>
    (offsets[line] ?? document.length) + (lines[line]?.length ?? 0);
  const range = (map: [number, number]): Span => ({
    start: offsets[map[0]],
    end: endOfLine(map[1] - 1),
  });
  const fences: Span[] = [];
  tokens.forEach((token, index) => {
    if (!["fence", "code_block"].includes(token.type) || !token.map) return;
    // Keep an approval record and its reference together, just as parseBlocks does.
    const previous = tokens[index - 1];
    if (
      token.info.trim() === "diff" &&
      previous?.type === "fence" &&
      previous.info.trim() === "review-diff"
    )
      return;
    const next = tokens[index + 1];
    const own = range(token.map);
    if (
      token.info.trim() === "review-diff" &&
      next?.type === "fence" &&
      next.info.trim() === "diff" &&
      next.map
    )
      own.end = range(next.map).end;
    fences.push(own);
  });
  return { lines, offsets, tokens, range, endOfLine, fences };
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function plan(
  document: string,
  span: Span,
  replacement: string,
  target: Span = span,
  structural = false,
): Resolution {
  const lineAt = (at: number) =>
    (document.slice(0, at).match(/\r\n|\r|\n/g) ?? []).length;
  return {
    problems: [],
    span: {
      ...span,
      replacement,
      target: {
        startLine: lineAt(target.start),
        endLine: lineAt(Math.max(target.start, target.end - 1)) + 1,
        ...(structural && { structural: true }),
      },
    },
  };
}

function separated(document: string, span: Span, replacement: string): string {
  const eol = document.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  const before = document.slice(0, span.start);
  const after = document.slice(span.end);
  const breaks = (gap: string) => (gap.match(/\r\n|\r|\n/g) ?? []).length;
  const leading = before
    ? eol.repeat(Math.max(0, 2 - breaks(/[ \t\r\n]*$/.exec(before)![0])))
    : "";
  const trailing = after.trim()
    ? eol.repeat(Math.max(0, 2 - breaks(/^[ \t\r\n]*/.exec(after)![0])))
    : "";
  return leading + replacement + trailing;
}

function blockPlan(
  document: string,
  span: Span,
  replacement: string,
  target = span,
  structural = false,
): Resolution {
  const adjusted = { ...span };
  while (adjusted.start > 0 && /[ \t]/.test(document[adjusted.start - 1]))
    adjusted.start--;
  while (adjusted.end < document.length && /[ \t]/.test(document[adjusted.end]))
    adjusted.end++;
  return plan(
    document,
    adjusted,
    separated(document, adjusted, replacement),
    target,
    structural,
  );
}
function insertInContainer(
  document: string,
  suggestion: SuggestionInput,
  found: Span,
  parsed: ReturnType<typeof structure>,
): Resolution {
  const fail = (message: string): Resolution => ({ problems: [message] });
  const contains = (span: Span) =>
    span.start <= found.start && span.end >= found.end;
  const eol = document.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  if (suggestion.operation === "insert-table-rows") {
    const table = parsed.tokens.find(
      (token) =>
        token.type === "table_open" &&
        token.map &&
        contains(parsed.range(token.map)),
    );
    if (!table?.map || table.level !== 0)
      return fail(
        "insert-table-rows needs an anchor in a top-level table row.",
      );
    const row = parsed.tokens.find(
      (token) =>
        token.type === "tr_open" &&
        token.map &&
        token.map[0] >= table.map![0] &&
        token.map[1] <= table.map![1] &&
        contains(parsed.range(token.map)),
    );
    if (!row?.map)
      return fail("Anchor one table row, not a delimiter or several rows.");
    let rows: ReturnType<typeof md.parse>;
    try {
      rows = parseTableRows(suggestion.replacement);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return fail(error.message);
    }
    const tableIndex = parsed.tokens.indexOf(table);
    const header = parsed.tokens.slice(
      tableIndex + 1,
      parsed.tokens.findIndex(
        (token, index) => index > tableIndex && token.type === "thead_close",
      ),
    );
    const width = header.filter((token) => token.type === "th_open").length;
    const insertedWidth =
      rows.filter((token) => token.type === "td_open").length /
      rows.filter((token) => token.type === "tr_open").length;
    if (width !== insertedWidth)
      return fail(
        `Table rows need ${width} columns; received ${insertedWidth}.`,
      );
    const line =
      row.map[0] === table.map[0] ? table.map[0] + 1 : row.map[1] - 1;
    const at = parsed.endOfLine(line);
    const indent = /^[ \t]*/.exec(parsed.lines[table.map[0]])![0];
    const content = suggestion.replacement
      .trim()
      .split(/\r\n|\r|\n/)
      .map((text) => indent + text.trim())
      .join(eol);
    return plan(
      document,
      { start: at, end: at },
      eol + content,
      parsed.range(row.map),
      true,
    );
  }
  const item = parsed.tokens
    .filter(
      (token) =>
        token.type === "list_item_open" &&
        token.map &&
        contains(parsed.range(token.map)),
    )
    .sort((a, b) => b.level - a.level)[0];
  if (!item?.map)
    return fail("insert-list-items needs an anchor in a list item.");
  if (
    parsed.tokens.some(
      (token) =>
        token !== item &&
        token.type === "list_item_open" &&
        token.map?.[0] === item.map![0],
    )
  )
    return fail(
      "Same-line nested list targets are unsupported; put the child on its own line.",
    );
  const marker = /^([ ]*)([-+*]|\d{1,9}[.)])([ ]+)(.*)$/.exec(
    parsed.lines[item.map[0]],
  );
  if (!marker)
    return fail(
      "List insertion supports space-indented lists outside block quotes.",
    );
  const incoming = structure(suggestion.replacement);
  const list = incoming.tokens[0];
  const items = incoming.tokens.filter(
    (token) => token.type === "list_item_open",
  );
  if (
    !list?.map ||
    !["bullet_list_open", "ordered_list_open"].includes(list.type) ||
    list.map[0] !== 0 ||
    list.map[1] !== incoming.lines.length ||
    !items.length ||
    items.some(
      (token) =>
        token.level !== 1 || !token.map || token.map[1] - token.map[0] !== 1,
    )
  )
    return fail(
      "Supply one or more single-line sibling list items, without nested items or other blocks.",
    );
  const content = items.map((token, index) => {
    const text = incoming.lines[token.map![0]];
    const supplied = /^[ ]*(?:[-+*]|\d{1,9}[.)])[ ]+(.+)$/.exec(text);
    if (!supplied) return undefined;
    const number = Number.parseInt(marker[2], 10) + index + 1;
    if (/^\d/.test(marker[2]) && number > 999999999) return undefined;
    const bullet = /^\d/.test(marker[2])
      ? `${number}${marker[2].slice(-1)}`
      : marker[2];
    return marker[1] + bullet + marker[3] + supplied[1];
  });
  if (content.some((line) => line === undefined))
    return fail("List items must contain text after their marker.");
  let endLine = item.map[1] - 1;
  while (endLine > item.map[0] && !parsed.lines[endLine].trim()) endLine--;
  const at = parsed.endOfLine(endLine);
  return plan(
    document,
    { start: at, end: at },
    eol + content.join(eol),
    { start: parsed.offsets[item.map[0]], end: parsed.endOfLine(endLine) },
    true,
  );
}
/** Locates where the suggestion applies; insertions get an empty span. */
export function resolve(
  document: string,
  suggestion: SuggestionInput,
): Resolution {
  if (
    ("mode" in suggestion &&
      suggestion.mode !== "block" &&
      suggestion.mode !== undefined) ||
    ("preview" in suggestion && suggestion.preview !== undefined)
  )
    return {
      problems: [
        "Legacy literal proposal: recapture it with a structural operation before accepting.",
      ],
    };
  const operation =
    suggestion.operation ??
    (suggestion.from !== undefined ? "replace" : "insert-block");
  const parsed = structure(document);
  if (suggestion.after !== undefined) {
    const found = unique(document, suggestion.after, "after");
    if (typeof found === "string") return { problems: [found] };
    if (operation === "replace")
      return { problems: ["replace needs from/to, not after."] };
    if (operation !== "insert-block")
      return insertInContainer(document, suggestion, found, parsed);
    let at = balance(document, found).end;
    const container = parsed.tokens.find(
      (token) =>
        token.level === 0 &&
        token.map &&
        token.type !== "paragraph_open" &&
        overlaps(parsed.range(token.map), found),
    );
    if (container?.map) at = parsed.range(container.map).end;
    const fence = parsed.fences.find((f) => overlaps(f, found));
    if (fence) at = fence.end;
    const span = { start: at, end: at };
    return blockPlan(
      document,
      span,
      suggestion.replacement,
      fence ?? (container?.map ? parsed.range(container.map) : found),
      !!fence || !!container,
    );
  }
  if (suggestion.from === undefined || suggestion.to === undefined)
    return operation === "insert-block"
      ? blockPlan(
          document,
          { start: document.trimEnd().length, end: document.trimEnd().length },
          suggestion.replacement,
        )
      : { problems: [`${operation} needs an anchor.`] };
  if (operation !== "replace")
    return { problems: ["Insertion operations use after, not from/to."] };
  const from = unique(document, suggestion.from, "from");
  if (typeof from === "string") return { problems: [from] };
  // The span must contain the whole from quote, even when to is shorter.
  const endings = occurrences(document, suggestion.to, from.start).filter(
    (found) => found.end >= from.end,
  );
  if (suggestion.operation && endings.length > 1)
    return {
      problems: [
        `to occurs ${endings.length} times after from, use a longer quote.`,
      ],
    };
  const to = endings[0];
  if (!to) return { problems: [`to not found after from: "${suggestion.to}"`] };
  let { start, end } = balance(document, { start: from.start, end: to.end });
  const blocks = parsed.tokens
    .filter((token) => token.level === 0 && token.map)
    .map((token) => ({ token, span: parsed.range(token.map!) }))
    .filter((block) => overlaps(block.span, { start, end }));
  let blockLevel = false;
  for (const block of blocks)
    if (
      block.token.type === "table_open" ||
      (blocks.length > 1 && block.token.type !== "paragraph_open")
    ) {
      start = Math.min(start, block.span.start);
      end = Math.max(end, block.span.end);
      blockLevel = true;
    }
  for (const fence of parsed.fences)
    if (overlaps(fence, { start, end })) {
      start = Math.min(start, fence.start);
      end = Math.max(end, fence.end);
      blockLevel = true;
    }
  // Whole lines and block replacements take the line's markers, which quotes cannot include.
  const lineStart = document.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = document.indexOf("\n", end);
  const wholeLines = !document
    .slice(end, lineEnd === -1 ? undefined : lineEnd)
    .trim();
  if (
    start > lineStart &&
    blockMarkers.test(document.slice(lineStart, start)) &&
    (wholeLines || suggestion.replacement.includes("\n"))
  )
    start = lineStart;
  const span = { start, end };
  const replacementType = structure(suggestion.replacement).tokens[0]?.type;
  const listReplacement = ["bullet_list_open", "ordered_list_open"].includes(
    replacementType,
  );
  if (
    !blockLevel &&
    listReplacement &&
    blocks.some(({ token }) =>
      ["bullet_list_open", "ordered_list_open"].includes(token.type),
    )
  )
    return plan(document, span, suggestion.replacement);
  return blockLevel ||
    suggestion.replacement.includes("\n") ||
    (replacementType && replacementType !== "paragraph_open")
    ? blockPlan(document, span, suggestion.replacement, span, blockLevel)
    : plan(document, span, suggestion.replacement);
}

export function applySuggestion(document: string, span: EditPlan): string {
  return (
    document.slice(0, span.start) + span.replacement + document.slice(span.end)
  );
}
