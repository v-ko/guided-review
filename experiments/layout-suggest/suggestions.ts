/**
 * An agent suggestion. The anchor is from+to (replace that span), after
 * (insert a block after a quote) or neither (append to the document end).
 */
export interface SuggestionInput {
  replacement: string;
  from?: string;
  to?: string;
  after?: string;
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

// What may precede a plain-text quote on its line: indentation, >, list items, task boxes, headings.
const blockMarkers =
  /^[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)*$/;

/** Validates untrusted tool input, reporting every problem at once. */
export function checkSuggestion(value: unknown): {
  input?: SuggestionInput;
  problems: string[];
} {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { problems: ["Suggestion must be an object."] };
  const record = value as Record<string, unknown>;
  const problems = Object.keys(record)
    .filter((key) => !(fields as readonly string[]).includes(key))
    .map((key) => `Unknown field ${key}.`);
  const input: Record<string, string> = {};
  for (const field of fields) {
    const text = record[field];
    if (text === undefined && field !== "replacement") continue;
    if (typeof text === "string" && text.trim()) input[field] = text.trim();
    else problems.push(`${field} must be a non-empty string.`);
  }
  const has = (field: string) => record[field] !== undefined;
  if (has("from") !== has("to")) problems.push("from and to go together.");
  if (has("after") && (has("from") || has("to")))
    problems.push("Use either from/to or after, not both.");
  if (problems.length) return { problems };
  return { input: input as unknown as SuggestionInput, problems };
}

function occurrences(text: string, quote: string): number[] {
  const found: number[] = [];
  for (
    let index = text.indexOf(quote);
    index !== -1;
    index = text.indexOf(quote, index + 1)
  )
    found.push(index);
  return found;
}

function unique(
  document: string,
  quote: string,
  name: string,
): number | string {
  const found = occurrences(document, quote);
  if (found.length === 1) return found[0];
  return found.length
    ? `${name} occurs ${found.length} times, use a longer quote: "${quote}"`
    : `${name} not found: "${quote}"`;
}

/** Locates where the suggestion applies; insertions get an empty span. */
export function resolve(
  document: string,
  suggestion: SuggestionInput,
): Resolution {
  if (suggestion.after !== undefined) {
    const found = unique(document, suggestion.after, "after");
    if (typeof found === "string") return { problems: [found] };
    const at = found + suggestion.after.length;
    return { span: { start: at, end: at }, problems: [] };
  }
  if (suggestion.from === undefined || suggestion.to === undefined)
    return {
      span: { start: document.length, end: document.length },
      problems: [],
    };
  const start = unique(document, suggestion.from, "from");
  if (typeof start === "string") return { problems: [start] };
  // The span must contain the whole from quote, even when to is shorter.
  const toIndex = document.indexOf(
    suggestion.to,
    Math.max(start, start + suggestion.from.length - suggestion.to.length),
  );
  if (toIndex === -1)
    return { problems: [`to not found after from: "${suggestion.to}"`] };
  const end = toIndex + suggestion.to.length;
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
  const tail = after.trimStart();
  const ending = document.slice(document.trimEnd().length);
  return (
    (head && head + "\n\n") + replacement + (tail ? "\n\n" + tail : ending)
  );
}
