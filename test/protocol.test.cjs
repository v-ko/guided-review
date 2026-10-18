"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { decodeWebviewMessage } = require("../out/src/protocol.js");

test("webview protocol decodes supported intents and strips unrelated fields", () => {
  for (const message of [
    { type: "ready" },
    { type: "refresh" },
    { type: "edit" },
    { type: "approve", id: "one", fingerprint: "captured" },
    { type: "approve", id: "one", fingerprint: "" },
    { type: "diff", id: "one", hunkId: undefined },
    { type: "diff", id: "one", hunkId: "h-one" },
    { type: "diff", id: "one", hunkId: "" },
    { type: "source", id: "one", line: undefined },
    { type: "source", id: "one", line: 3 },
    { type: "source", id: "one", line: Number.MAX_SAFE_INTEGER },
  ])
    assert.deepEqual(
      decodeWebviewMessage({ ...message, ignored: "not forwarded" }),
      message,
    );
});

test("webview protocol rejects malformed input before host work", () => {
  for (const value of [
    undefined,
    null,
    false,
    1,
    "ready",
    [],
    {},
    { type: "unknown" },
    { type: "approve", id: "one" },
    { type: "approve", fingerprint: "captured" },
    { type: "approve", id: "", fingerprint: "captured" },
    { type: "approve", id: 1, fingerprint: "captured" },
    { type: "approve", id: "one", fingerprint: null },
    { type: "approve", id: "one", fingerprint: 1 },
    { type: "diff" },
    { type: "diff", id: "" },
    { type: "diff", id: 1 },
    { type: "diff", id: "one", hunkId: 1 },
    { type: "diff", id: "one", hunkId: null },
    { type: "source" },
    { type: "source", id: "" },
    { type: "source", id: 1 },
    { type: "source", id: "one", line: null },
    { type: "source", id: "one", line: "1" },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((line) => ({
      type: "source",
      id: "one",
      line,
    })),
  ])
    assert.equal(decodeWebviewMessage(value), undefined);
});
