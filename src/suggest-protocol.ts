export interface SuggestionView {
  id: string;
  /** Anchor quotes in the document text; none means append at the end. */
  from?: string;
  to?: string;
  after?: string;
  /** layout is shown by matching kept text, edit as a word diff. */
  kind: "layout" | "edit";
  html: string;
  problems: string[];
}

export type SuggestionSummary = Omit<SuggestionView, "html">;

export interface RenderMessage {
  type: "render";
  /** The session name, kept in the webview state to restore the panel. */
  session: string;
  /** The document file. */
  path: string;
  /** Identifies the file contents this view was built from. */
  fingerprint: string;
  document: string;
  suggestions: SuggestionView[];
}

export interface SelectedText {
  /** Rendered text, without Markdown syntax. */
  text: string;
  /** "document" or the id of the suggestion it was selected in. */
  source: string;
}

export interface AcceptMessage {
  type: "accept";
  id: string;
  fingerprint: string;
}

/** Opens the document in the editor. */
export interface OpenMessage {
  type: "open";
}

/** Asks for new suggestions; without text, for more of the same. */
export interface RequestMessage {
  type: "request";
  /** Chosen by the page to recognize its request in status messages. */
  id: string;
  text?: string;
  selection?: SelectedText;
  /** Id of the suggestion card the reader selected. */
  selected?: string;
  /** Ids the reader declined since the last request. */
  declined?: string[];
}

/** Withdraws a request the agent has not picked up yet. */
export interface CancelMessage {
  type: "cancel";
  id: string;
}

/** Stages the changes a document block shows, then marks the block approved. */
export interface ApproveMessage {
  type: "approve";
  block: string;
  /** What the block showed; staging is refused if it changed since. */
  fingerprint: string;
}

/** Removes the approval mark of a block whose changes are no longer staged. */
export interface UnapproveMessage {
  type: "unapprove";
  block: string;
}

export interface NavigateMessage {
  type: "source" | "diff";
  block: string;
  /** Identity of the span selected in the rendered block. */
  target: string;
}

export type PageAction =
  | AcceptMessage
  | OpenMessage
  | RequestMessage
  | CancelMessage
  | ApproveMessage
  | UnapproveMessage
  | NavigateMessage;

/** Page to host: an action with a call number, or the page asking for its first render. */
export type PageMessage = { type: "ready" } | (PageAction & { call: number });

/** Host to page: the outcome of a call. */
export interface ReplyMessage {
  type: "reply";
  call: number;
  error?: string;
}

/** listening: waiting for feedback; working: has a request and has not waited since. */
export type AgentState = "away" | "listening" | "working";

export interface StatusMessage {
  type: "status";
  agent: AgentState;
  /** Epoch milliseconds when the agent entered that state. */
  since: number;
  /** The request waiting for the agent. */
  pending?: RequestMessage;
  /** Id of the request the agent picked up last. */
  delivered?: string;
}

export type SuggestHostMessage = RenderMessage | StatusMessage | ReplyMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const isId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= 100;

/** undefined when absent, null when malformed. */
function decodeIds(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every((id) => typeof id === "string" && id)
  )
    return null;
  return value as string[];
}

function decodeRequest(
  value: Record<string, unknown>,
): RequestMessage | undefined {
  const { id, text, selection, selected } = value;
  const declined = decodeIds(value.declined);
  if (
    !isId(id) ||
    (text !== undefined && typeof text !== "string") ||
    declined === null ||
    (selected !== undefined && !isId(selected))
  )
    return undefined;
  const message: RequestMessage = {
    type: "request",
    id,
    ...(text?.trim() && { text: text.trim() }),
    ...(selected !== undefined && { selected }),
    ...(declined && { declined }),
  };
  if (selection === undefined) return message;
  if (
    !isRecord(selection) ||
    typeof selection.text !== "string" ||
    !selection.text.trim() ||
    typeof selection.source !== "string"
  )
    return undefined;
  return {
    ...message,
    selection: { text: selection.text, source: selection.source },
  };
}

function decodeAction(value: Record<string, unknown>): PageAction | undefined {
  switch (value.type) {
    case "accept":
      return isId(value.id) && typeof value.fingerprint === "string"
        ? { type: "accept", id: value.id, fingerprint: value.fingerprint }
        : undefined;
    case "open":
      return { type: "open" };
    case "request":
      return decodeRequest(value);
    case "cancel":
      return isId(value.id) ? { type: "cancel", id: value.id } : undefined;
    case "approve":
      return isId(value.block) && typeof value.fingerprint === "string"
        ? {
            type: "approve",
            block: value.block,
            fingerprint: value.fingerprint,
          }
        : undefined;
    case "unapprove":
      return isId(value.block)
        ? { type: "unapprove", block: value.block }
        : undefined;
    case "source":
    case "diff":
      return isId(value.block) &&
        typeof value.target === "string" &&
        /^[0-9a-f]{64}$/.test(value.target)
        ? { type: value.type, block: value.block, target: value.target }
        : undefined;
    default:
      return undefined;
  }
}

/** A well-formed page message; a malformed action keeps its call number so the page gets a reply. */
export function decodePageMessage(
  value: unknown,
): PageMessage | { type: "malformed"; call: number } | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "ready") return { type: "ready" };
  const call = value.call;
  if (typeof call !== "number" || !Number.isSafeInteger(call)) return undefined;
  const action = decodeAction(value);
  return action ? { ...action, call } : { type: "malformed", call };
}
