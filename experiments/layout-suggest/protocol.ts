export interface SuggestionView {
  id: string;
  /** Anchor quotes in the document text; none means append at the end. */
  from?: string;
  to?: string;
  after?: string;
  html: string;
  problems: string[];
}

export type SuggestionSummary = Omit<SuggestionView, "html">;

export interface RenderMessage {
  type: "render";
  /** Identifies the file contents this view was built from. */
  fingerprint: string;
  document: string;
  suggestions: SuggestionView[];
}

export interface AcceptMessage {
  type: "accept";
  id: string;
  fingerprint: string;
}

export interface SelectedText {
  /** Rendered text, without Markdown syntax. */
  text: string;
  /** "document" or the id of the suggestion it was selected in. */
  source: string;
}

export interface PromptMessage {
  type: "prompt";
  text: string;
  selection?: SelectedText;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function decodeAccept(value: unknown): AcceptMessage | undefined {
  if (!isRecord(value)) return undefined;
  const { type, id, fingerprint } = value;
  if (type !== "accept" || typeof id !== "string" || !id) return undefined;
  if (typeof fingerprint !== "string" || !fingerprint) return undefined;
  return { type, id, fingerprint };
}

export function decodePrompt(value: unknown): PromptMessage | undefined {
  if (!isRecord(value)) return undefined;
  const { type, text, selection } = value;
  if (type !== "prompt" || typeof text !== "string" || !text.trim())
    return undefined;
  if (selection === undefined) return { type, text };
  if (
    !isRecord(selection) ||
    typeof selection.text !== "string" ||
    !selection.text.trim() ||
    typeof selection.source !== "string"
  )
    return undefined;
  return {
    type,
    text,
    selection: { text: selection.text, source: selection.source },
  };
}
