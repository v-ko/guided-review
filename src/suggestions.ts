/**
 * layout restructures the text it covers and is shown by matching what it keeps;
 * edit rewords it and is shown as a word diff.
 */
export type SuggestionKind = "layout" | "edit";

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
}

export interface Suggestion extends SuggestionInput {
  id: string;
}

export interface Span {
  start: number;
  end: number;
}

export interface Resolution {
  span?: Span;
  problems: string[];
}

const fields = ["replacement", "from", "to", "after"] as const;
const kinds: readonly string[] = ["layout", "edit"];

// What may precede a plain-text quote on its line: indentation, >, list items, task boxes, headings.
const blockMarkers =
  /^[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)*$/;
// Lines that interrupt a paragraph: quotes, list items, headings.
const startsBlock = /^[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])[ \t]|#{1,6}[ \t])/;

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
      (key) => key !== "kind" && !(fields as readonly string[]).includes(key),
    )
    .map((key) => `Unknown field ${key}.`);
  const input: Record<string, string> = {};
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
  if (has("kind")) {
    if (typeof record.kind !== "string" || !kinds.includes(record.kind))
      problems.push("kind must be layout or edit.");
    else if (record.kind === "edit" && !has("from"))
      problems.push("An edit needs from/to: it rewords existing text.");
    else if (record.kind === "edit") input.kind = "edit";
  }
  if (problems.length) return { problems };
  return { input: input as unknown as SuggestionInput, problems };
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

/** Fenced code blocks, from the opening fence line to the end of the closing one (or the document). */
function fences(document: string, approvedPairs = false): Span[] {
  const found: (Span & { info: string })[] = [];
  let open: { start: number; fence: string; info: string } | undefined;
  let offset = 0;
  for (const line of document.split("\n")) {
    const fence = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      if (fence && !(fence[1][0] === "`" && fence[2].includes("`")))
        open = { start: offset, fence: fence[1], info: fence[2].trim() };
    } else if (
      fence &&
      fence[1][0] === open.fence[0] &&
      fence[1].length >= open.fence.length &&
      !fence[2].trim()
    ) {
      found.push({
        start: open.start,
        end: offset + line.length,
        info: open.info,
      });
      open = undefined;
    }
    offset += line.length + 1;
  }
  if (open)
    found.push({ start: open.start, end: document.length, info: open.info });
  if (!approvedPairs) return found.map(({ start, end }) => ({ start, end }));
  const blocks: Span[] = [];
  for (let index = 0; index < found.length; index++) {
    const fence = found[index];
    const next = found[index + 1];
    // The recorded diff must stay adjacent to its reference to remain approved.
    if (
      fence.info === "review-diff" &&
      next?.info === "diff" &&
      !document.slice(fence.end, next.start).trim()
    ) {
      blocks.push({ start: fence.start, end: next.end });
      index++;
    } else blocks.push({ start: fence.start, end: fence.end });
  }
  return blocks;
}

/** Widens a span that cuts through a fence so it never leaves half of one behind. */
function wholeFences(document: string, span: Span): Span {
  let { start, end } = span;
  for (const fence of fences(document)) {
    const inside = (at: number) => fence.start < at && at < fence.end;
    if (inside(start) && !inside(end)) start = fence.start;
    else if (inside(end) && !inside(start)) end = fence.end;
  }
  return { start, end };
}

/** Locates where the suggestion applies; insertions get an empty span. */
export function resolve(
  document: string,
  suggestion: SuggestionInput,
): Resolution {
  if (suggestion.after !== undefined) {
    const found = unique(document, suggestion.after, "after");
    if (typeof found === "string") return { problems: [found] };
    let at = balance(document, found).end;
    // A block inserted inside a fence would become code.
    const fence = fences(document, true).find(
      (f) => f.start < at && at < f.end,
    );
    if (fence) at = fence.end;
    return { span: { start: at, end: at }, problems: [] };
  }
  if (suggestion.from === undefined || suggestion.to === undefined)
    return {
      span: { start: document.length, end: document.length },
      problems: [],
    };
  const from = unique(document, suggestion.from, "from");
  if (typeof from === "string") return { problems: [from] };
  // The span must contain the whole from quote, even when to is shorter.
  const to = occurrences(document, suggestion.to, from.start).find(
    (found) => found.end >= from.end,
  );
  if (!to) return { problems: [`to not found after from: "${suggestion.to}"`] };
  const { start, end } = wholeFences(
    document,
    balance(document, { start: from.start, end: to.end }),
  );
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
    return { span: { start: lineStart, end }, problems: [] };
  return { span: { start, end }, problems: [] };
}

export function applySuggestion(
  document: string,
  span: Span,
  replacement: string,
): string {
  const before = document.slice(0, span.start);
  const after = document.slice(span.end);
  if (span.start < span.end && !replacement.includes("\n"))
    return before + replacement + after;
  // Block Markdown and insertions must not merge with the surrounding paragraph.
  const head = before.trimEnd();
  const space = /^\s*/.exec(after)![0];
  // The next line keeps its indent.
  const tail = after.slice(space.lastIndexOf("\n") + 1 || space.length);
  const ending = document.slice(document.trimEnd().length);
  const afterGap = after.slice(0, after.length - tail.length);
  // An insertion takes the spacing at its anchor; an append is a new block.
  const startGap =
    span.start === document.length
      ? ""
      : before.slice(head.length) + (span.start === span.end ? afterGap : "");
  return (
    (head && head + separator(startGap, replacement)) +
    replacement +
    (tail.trim() ? separator(afterGap, tail) + tail : ending)
  );
}

// Keeps blank lines, and a single line break before a line that starts its own block.
function separator(gap: string, next: string): string {
  if (/\n[ \t\r]*\n/.test(gap)) return gap;
  return gap.includes("\n") && startsBlock.test(next) ? "\n" : "\n\n";
}
