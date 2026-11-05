import * as readline from "node:readline";
import type { Session } from "./session.js";

type Id = string | number;

export interface McpInfo {
  page: string;
  document: string;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const noArguments = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const tools = [
  {
    name: "wait_for_feedback",
    description:
      "Long-poll the layout suggestions page for reader feedback. Returns accepted suggestions (already applied to the document and removed from the list) and reader prompts, or no events on timeout, plus the current suggestion list with any quote problems. Afterwards re-read the document.",
    inputSchema: {
      type: "object",
      properties: {
        timeout_seconds: {
          type: "number",
          minimum: 1,
          maximum: 600,
          description: "Default 60.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "add_suggestions",
    description:
      "Add suggestions; they appear on top of the page in the given order. Each replaces the span from..to, inserts after a quote, or appends to the end when no anchor is given. Returns the new ids and the rejected items with their problems.",
    inputSchema: {
      type: "object",
      properties: {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              replacement: {
                type: "string",
                description: "Markdown that replaces the span or is inserted.",
              },
              from: {
                type: "string",
                description: "Unique quote where the replaced span starts.",
              },
              to: {
                type: "string",
                description: "Quote where the replaced span ends.",
              },
              after: {
                type: "string",
                description: "Unique quote to insert after.",
              },
            },
            required: ["replacement"],
            additionalProperties: false,
          },
        },
      },
      required: ["suggestions"],
      additionalProperties: false,
    },
  },
  {
    name: "remove_suggestions",
    description: "Remove suggestions by id.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "list_suggestions",
    description:
      "List current suggestions (without replacements) with any quote problems.",
    inputSchema: noArguments,
  },
  {
    name: "clear_session",
    description:
      "Empty the document and the suggestions and drop queued feedback, to start on a new text.",
    inputSchema: noArguments,
  },
];

function instructions(info: McpInfo): string {
  return `Layout suggestions for a dictated Markdown document. The reader opens ${info.page}.
Document (read-only for you): ${info.document}
All your changes go through suggestions, even on an empty document. Keep 2-3 suggestions that restructure parts of the document: sections, bullet points, splitting into notes, Mermaid diagrams built from the content. Do not reword.
A suggestion replaces the span from..to, inserts after a quote, or appends to the end without an anchor. Quotes are plain text without Markdown syntax; from and after must be unique. A span covering whole lines also replaces their markers (-, 1., #, >), so repeat them in the replacement to keep them.
Remove stale suggestions with remove_suggestions. An empty list shows OK on the page.
Call wait_for_feedback to learn what the reader did. An accept changes the document and may break other suggestions' quotes; the returned list shows their problems.
Reader prompts arrive as {"type":"prompt","text","selection"?:{"text","source"}}: selection is rendered text the reader selected, source is "document" or the suggestion id it was selected in. A prompt guides the next suggestions and wins over the defaults above when they conflict.`;
}

function textResult(value: unknown, isError = false): object {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], ...(isError && { isError }) };
}

/** Newline-delimited JSON-RPC MCP server for the suggestion tools. */
export function serveMcp(
  session: Session,
  info: McpInfo,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  log: (line: string) => void,
): void {
  const pending = new Set<Id>();
  function send(message: object): void {
    output.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  async function handle(
    method: string,
    params: Record<string, unknown>,
    id: Id,
  ): Promise<unknown> {
    switch (method) {
      case "initialize":
        return {
          // The tools work the same in every protocol revision.
          protocolVersion:
            typeof params.protocolVersion === "string"
              ? params.protocolVersion
              : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "layout-suggest", version: "0.1.0" },
          instructions: instructions(info),
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools };
      case "tools/call": {
        const args = isRecord(params.arguments) ? params.arguments : {};
        switch (params.name) {
          case "wait_for_feedback": {
            const seconds =
              typeof args.timeout_seconds === "number"
                ? Math.min(600, Math.max(1, args.timeout_seconds))
                : 60;
            const events = await session.wait(id, seconds * 1000);
            const suggestions = await session.list();
            return textResult({ events, suggestions, ...info });
          }
          case "add_suggestions":
            if (!Array.isArray(args.suggestions))
              return textResult("suggestions must be an array.", true);
            return textResult(await session.add(args.suggestions));
          case "remove_suggestions": {
            const ids: unknown = args.ids;
            if (
              !Array.isArray(ids) ||
              !ids.every((item) => typeof item === "string")
            )
              return textResult("ids must be an array of strings.", true);
            return textResult(await session.remove(ids));
          }
          case "list_suggestions":
            return textResult(await session.list());
          case "clear_session":
            await session.clear();
            return textResult("Cleared.");
          default:
            throw new RpcError(-32602, `Unknown tool: ${String(params.name)}`);
        }
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  async function dispatch(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.method !== "string") {
      if (
        isRecord(message) &&
        message.id !== undefined &&
        message.method !== undefined
      )
        send({
          id: message.id,
          error: { code: -32600, message: "Invalid request" },
        });
      return; // Responses from the client are not expected.
    }
    const params = isRecord(message.params) ? message.params : {};
    const id = message.id;
    if (typeof id !== "string" && typeof id !== "number") {
      const requestId = params.requestId;
      if (
        message.method === "notifications/cancelled" &&
        (typeof requestId === "string" || typeof requestId === "number") &&
        pending.delete(requestId)
      )
        session.cancel(requestId);
      return;
    }
    pending.add(id);
    try {
      const result = await handle(message.method, params, id);
      // Cancelled requests get no response.
      if (pending.delete(id)) send({ id, result });
    } catch (error) {
      pending.delete(id);
      const code = error instanceof RpcError ? error.code : -32603;
      if (code === -32603)
        log(`MCP ${message.method} failed: ${String(error)}`);
      send({ id, error: { code, message: String((error as Error).message) } });
    }
  }

  readline.createInterface({ input }).on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    void dispatch(message);
  });
}
