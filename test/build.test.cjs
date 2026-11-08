"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
function read(relative) {
  return fs.readFile(path.join(root, relative), "utf8");
}

// Strict compilation does not reject explicit any or suppression directives.
test("authored runtime modules are typed without suppression directives or explicit any", async () => {
  function checkTypes(source, relative) {
    assert.doesNotMatch(
      source,
      /@ts-(?:ignore|nocheck|expect-error)\b/,
      `${relative} suppresses type checks`,
    );
    assert.doesNotMatch(
      source,
      /(?:[:<,=|&]|\bas\b|\bextends\b)\s*any\b/,
      `${relative} must use specific types or unknown`,
    );
  }
  const authored = [];
  for (const directory of ["src", "media"]) {
    for (const name of await fs.readdir(path.join(root, directory), {
      recursive: true,
    })) {
      if (/\.(?:ts|mts)$/.test(name))
        authored.push(`${directory}/${name.split(path.sep).join("/")}`);
    }
  }
  for (const relative of authored) {
    const source = await read(relative);
    checkTypes(source, relative);
  }
});
