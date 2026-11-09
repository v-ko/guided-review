"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { FileWatchers } = require("../out/src/watchers.js");

function fakeVscode() {
  const created = [];
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` }) },
    RelativePattern: class {
      constructor(base, pattern) {
        this.base = base;
        this.pattern = pattern;
      }
    },
    workspace: {
      createFileSystemWatcher(pattern) {
        function none() {
          return { dispose() {} };
        }
        const watcher = {
          pattern,
          disposed: false,
          dispose() {
            this.disposed = true;
          },
          onDidChange(listener) {
            this.change = listener;
            return none();
          },
          onDidCreate: none,
          onDidDelete: none,
        };
        created.push(watcher);
        return watcher;
      },
    },
  };
  return { vscode, created };
}

const root = path.resolve("/repo");
function targets(branch) {
  return {
    gitPaths: [
      path.join(root, ".git", "index"),
      path.join(root, ".git", "refs", "heads", branch),
    ],
    files: [path.join(root, "a[1].js")],
  };
}

test("file watchers keep unchanged targets and replace changed ones", async () => {
  const { vscode, created } = fakeVscode();
  let changes = 0;
  const watchers = new FileWatchers(vscode, () => changes++);
  await watchers.update(Promise.resolve(targets("main")));
  assert.deepEqual(
    created.map((watcher) => watcher.pattern.pattern),
    ["index", "main", "a[[]1[]].js"],
  );
  assert.ok(
    watchers.watchedFiles.has(
      vscode.Uri.file(path.join(root, "a[1].js")).toString(),
    ),
  );
  created[1].change();
  assert.equal(changes, 1);
  await watchers.update(Promise.resolve(targets("main")));
  assert.equal(created.length, 3);
  await watchers.update(Promise.resolve(targets("feature")));
  assert.ok(created.slice(0, 3).every((watcher) => watcher.disposed));
  assert.deepEqual(
    created
      .slice(3)
      .map((watcher) => [watcher.pattern.pattern, watcher.disposed]),
    [
      ["index", false],
      ["feature", false],
      ["a[[]1[]].js", false],
    ],
  );
  watchers.dispose();
  assert.ok(created.every((watcher) => watcher.disposed));
});

test("file watchers allocate nothing when disposed during target discovery", async () => {
  const { vscode, created } = fakeVscode();
  const watchers = new FileWatchers(vscode, () => {});
  let resolve;
  const pending = watchers.update(
    new Promise((settle) => {
      resolve = settle;
    }),
  );
  watchers.dispose();
  resolve(targets("main"));
  await pending;
  assert.deepEqual(created, []);
  assert.equal(watchers.watchedFiles.size, 0);
});
