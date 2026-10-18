/** Messages exchanged only between the review webview and its extension host. */
export type WebviewMessage =
  | { type: "ready" | "refresh" | "edit" }
  | { type: "approve"; id: string; fingerprint: string }
  | { type: "diff"; id: string; hunkId?: string }
  | { type: "source"; id: string; line?: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Decode the webview's untrusted input; repository and freshness checks belong to the host. */
export function decodeWebviewMessage(
  value: unknown,
): WebviewMessage | undefined {
  if (!isRecord(value)) return;

  switch (value.type) {
    case "ready":
    case "refresh":
    case "edit":
      return { type: value.type };

    case "approve": {
      const { id, fingerprint } = value;
      if (!isNonEmptyString(id) || typeof fingerprint !== "string") return;
      return { type: "approve", id, fingerprint };
    }

    case "diff": {
      const { id, hunkId } = value;
      if (!isNonEmptyString(id)) return;
      if (hunkId !== undefined && typeof hunkId !== "string") return;
      return { type: "diff", id, hunkId };
    }

    case "source": {
      const { id, line } = value;
      if (!isNonEmptyString(id)) return;
      if (
        line !== undefined &&
        (typeof line !== "number" || !Number.isSafeInteger(line) || line <= 0)
      )
        return;
      return { type: "source", id, line };
    }
  }
}

export interface RenderContent {
  html: string;
  reviewed: number;
  total: number;
  stale: number;
  uncovered: number;
}
export interface RenderMessage extends RenderContent {
  type: "render";
}
export type HostMessage = RenderMessage | { type: "error"; message: string };
