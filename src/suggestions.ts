import MarkdownIt from "markdown-it";

/**
 * layout restructures the text it covers and is shown by matching what it keeps;
 * edit rewords it and is shown as a word diff.
 */
export type SuggestionKind = "layout" | "edit";
export type SuggestionMode = "block" | "literal";
export type SuggestionPreview = "tableRows";

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
  /** Literal uses exact source anchors and preserves replacement whitespace. */
  mode?: SuggestionMode;
  /** Card rendering only; never changes the replacement. */
  preview?: SuggestionPreview;
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
const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

/** Parses headerless rows as table cells, with no synthetic header in the result. */
export function parseTableRows(markdown: string): ReturnType<typeof md.parse> {
  const rows = markdown.split(/\r\n?|\n/);
  while (rows.length && !rows[0].trim()) rows.shift();
  while (rows.length && !rows.at(-1)!.trim()) rows.pop();
  if (!rows.length)
    throw new Error("tableRows needs at least one pipe-table row.");
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
        "tableRows needs only non-empty pipe-table rows with the same number of columns; omit headers and delimiter rows.",
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
      (key) =>
        !["kind", "mode", "preview"].includes(key) &&
        !(fields as readonly string[]).includes(key),
    )
    .map((key) => `Unknown field ${key}.`);
  const input: Partial<SuggestionInput> = {};
  const literal = record.mode === "literal";
  for (const field of fields) {
    const text = record[field];
    if (text === undefined && field !== "replacement") continue;
    if (
      typeof text === "string" &&
      (literal && field === "replacement" ? text.length : text.trim())
    )
      // The replacement keeps the first line's indent, which nests list items.
      input[field] = literal
        ? text
        : field === "replacement"
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
  if (has("mode")) {
    if (record.mode !== "block" && record.mode !== "literal")
      problems.push("mode must be block or literal.");
    else if (literal) input.mode = "literal";
  }
  if (has("preview")) {
    if (record.preview !== "tableRows")
      problems.push("preview must be tableRows.");
    else {
      input.preview = "tableRows";
      if (input.replacement !== undefined) {
        try {
          parseTableRows(input.replacement);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          problems.push(error.message);
        }
      }
    }
  }
  if (problems.length) return { problems };
  if (input.replacement === undefined)
    throw new Error("Validated suggestion is missing replacement.");
  return { input: { ...input, replacement: input.replacement }, problems };
}
