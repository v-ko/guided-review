"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("bundled skill and native tools are declared, trusted-only and documented by the skill", async () => {
  const root = path.resolve(__dirname, "..");
  const pkg = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await fs.readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  assert.equal(pkg.name, "guided-code-review");
  assert.equal(pkg.displayName, "Guided Review");
  assert.equal(pkg.version, lock.version);
  assert.equal(pkg.engines.vscode, lock.packages[""].engines.vscode);
  assert.equal(pkg.enabledApiProposals, undefined);
  assert.deepEqual(
    pkg.contributes.chatSkills.map((s) => s.path.replace(/^\.\//, "")),
    ["skills/guided-review/SKILL.md"],
  );
  const skill = await fs.readFile(
    path.join(root, pkg.contributes.chatSkills[0].path),
    "utf8",
  );
  assert.match(
    skill,
    /^---\nname: guided-review\ndescription: '[^\n]+'\nargument-hint: '[^\n]+'\n---\n/,
  );
  const tools = pkg.contributes.languageModelTools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "guidedReview_listSessions",
      "guidedReview_openSession",
      "guidedReview_waitForFeedback",
      "guidedReview_addSuggestions",
      "guidedReview_removeSuggestions",
      "guidedReview_listSuggestions",
      "guidedReview_captureCodeChanges",
    ],
  );
  for (const tool of tools) {
    assert.equal(tool.when, "isWorkspaceTrusted");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(skill.includes(tool.name), tool.name);
    assert.match(tool.toolReferenceName, /^guidedReview[A-Z]/);
  }
  const commands = pkg.contributes.commands.map((c) => c.command);
  assert.deepEqual(commands, [
    "layoutSuggest.openSession",
    "layoutSuggest.deleteSession",
  ]);
  for (const items of Object.values(pkg.contributes.menus))
    for (const item of items) assert.ok(commands.includes(item.command));
});
