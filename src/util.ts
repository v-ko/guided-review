import crypto, { type BinaryLike } from "node:crypto";

export function hash(value: BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[c];
  });
}
