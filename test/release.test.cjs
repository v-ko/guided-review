"use strict";

const { git: runGit } = require("./git.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  copyCandidate,
  checkArchiveEntries,
  licenseInventory,
  verificationEnv,
} = require("../scripts/verify-release.cjs");

test("clean candidate copies public saved files without Git history, private assets or source index changes", async (t) => {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "guided-code-review-release-test-"),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "source");
  await fs.mkdir(source);
  function git(...args) {
    return runGit(source, ...args);
  }
  git("init", "-b", "main");
  await fs.writeFile(
    path.join(source, ".gitignore"),
    "node_modules/\n.reviews/\n*.review.snapshot.json\n",
  );
  await fs.writeFile(path.join(source, "public.txt"), "staged version\n");
  git("add", "public.txt");
  const index = await fs.readFile(path.join(source, ".git", "index"));
  await fs.writeFile(
    path.join(source, "public.txt"),
    "saved working version\n",
  );
  if (process.platform !== "win32")
    await fs.chmod(path.join(source, "public.txt"), 0o755);
  await fs.writeFile(path.join(source, "new.txt"), "untracked saved source\n");
  await fs.mkdir(path.join(source, "node_modules"));
  await fs.mkdir(path.join(source, ".reviews"));
  await fs.writeFile(
    path.join(source, "node_modules", "private.txt"),
    "not public",
  );
  await fs.writeFile(path.join(source, ".reviews", "notes.md"), "not public");
  await fs.writeFile(
    path.join(source, "private.review.snapshot.json"),
    "not public",
  );
  const destination = path.join(temporary, "candidate");
  const configHome = path.join(temporary, "personal-config");
  await fs.mkdir(path.join(configHome, "git"), { recursive: true });
  await fs.writeFile(
    path.join(configHome, "git", "ignore"),
    "public.txt\nnew.txt\n",
  );
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  let files;
  try {
    process.env.XDG_CONFIG_HOME = configHome;
    files = await copyCandidate(source, destination);
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
  assert.deepEqual(Object.keys(files), [".gitignore", "new.txt", "public.txt"]);
  assert.match(files["public.txt"].hash, /^[a-f0-9]{64}$/);
  if (process.platform !== "win32") {
    assert.equal(files["public.txt"].mode, 0o755);
    assert.equal(
      (await fs.stat(path.join(destination, "public.txt"))).mode & 0o777,
      0o755,
    );
  }
  assert.equal(
    await fs.readFile(path.join(destination, "public.txt"), "utf8"),
    "saved working version\n",
  );
  assert.deepEqual(await fs.readdir(destination), [
    ".gitignore",
    "new.txt",
    "public.txt",
  ]);
  assert.deepEqual(
    await fs.readFile(path.join(source, ".git", "index")),
    index,
  );
  await assert.rejects(copyCandidate(source, destination), { code: "EEXIST" });
  await fs.symlink(
    source,
    path.join(source, "link.txt"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    copyCandidate(source, path.join(temporary, "symlink-candidate")),
    /contained regular file/,
  );
  await fs.rm(path.join(source, "link.txt"));
  await fs.writeFile(
    path.join(source, "leaked.review.snapshot.json"),
    "private",
  );
  git("add", "-f", "leaked.review.snapshot.json");
  await assert.rejects(
    copyCandidate(source, path.join(temporary, "private-candidate")),
    /Tracked files match ignore rules/,
  );
  const previous = process.env.GIT_INDEX_FILE;
  const mixed = process.env.Git_Common_Dir;
  try {
    process.env.GIT_INDEX_FILE = path.join(temporary, "foreign-index");
    process.env.Git_Common_Dir = path.join(temporary, "foreign-common");
    assert.equal(verificationEnv().GIT_INDEX_FILE, undefined);
    assert.equal(verificationEnv().Git_Common_Dir, undefined);
    assert.deepEqual(
      await copyCandidate(
        source,
        path.join(temporary, "redirect-candidate"),
      ).catch((error) => error.message),
      "Tracked files match ignore rules; remove private/generated files from the public candidate.",
    );
    await assert.rejects(fs.access(process.env.GIT_INDEX_FILE), {
      code: "ENOENT",
    });
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
    if (mixed === undefined) delete process.env.Git_Common_Dir;
    else process.env.Git_Common_Dir = mixed;
  }
});

test("actual VSIX inventory requires runtime assets and rejects private, source and development entries", () => {
  const files = [
    "[Content_Types].xml",
    "extension.vsixmanifest",
    "extension/package.json",
    "extension/readme.md",
    "extension/LICENSE.txt",
    "extension/out/src/extension.js",
    "extension/out/src/suggest-host.js",
    "extension/out/media/suggest.mjs",
    "extension/out/media/theme.mjs",
    "extension/out/media/match.mjs",
    "extension/media/suggest.css",
    "extension/skills/guided-review/SKILL.md",
    "extension/node_modules/mermaid/dist/mermaid.esm.min.mjs",
    "extension/node_modules/vscode-oniguruma/release/onig.wasm",
  ];
  checkArchiveEntries(files);
  for (const privateFile of [
    "extension/.aws/credentials",
    "extension/private.review.snapshot.json",
    "extension/out/src/extension.js.map",
    "extension/src/extension.ts",
    "extension/test/fixture.js",
    "extension/out/src/private/secret.js",
    "extension/out/private.js",
    "extension/media/private.json",
    "extension/media/review.css",
    "extension/skills/guided-review/private.json",
    "extension/skills/layout-suggest/SKILL.md",
    "extension/node_modules/@types/node/index.d.ts",
    "extension/../secret",
    "foreign/entry",
  ]) {
    assert.throws(
      () => checkArchiveEntries([...files, privateFile]),
      /Unexpected or private/,
    );
  }
  assert.throws(
    () =>
      checkArchiveEntries(
        [...files, "extension/node_modules/typescript/lib/typescript.js"],
        { packages: { "node_modules/typescript": { dev: true } } },
      ),
    /Unexpected or private/,
  );
  assert.throws(
    () => checkArchiveEntries([...files, files[0]]),
    /duplicate entries/,
  );
  assert.throws(
    () =>
      checkArchiveEntries(files.filter((file) => !file.endsWith("onig.wasm"))),
    /Missing VSIX entry/,
  );
  assert.throws(
    () =>
      checkArchiveEntries(files.filter((file) => !file.endsWith("match.mjs"))),
    /Missing VSIX entry/,
  );
});

test("license inventory accepts shipped license text without inventing a manifest declaration", async (t) => {
  const candidate = await fs.mkdtemp(
    path.join(os.tmpdir(), "guided-code-review-license-"),
  );
  t.after(() => fs.rm(candidate, { recursive: true, force: true }));
  await fs.mkdir(path.join(candidate, "node_modules", "fixture"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(candidate, "node_modules", "fixture", "package.json"),
    JSON.stringify({ name: "fixture", version: "1" }),
  );
  const manifest = "extension/node_modules/fixture/package.json";
  await assert.rejects(
    licenseInventory(candidate, [manifest]),
    /neither a license declaration nor license text/,
  );
  const license = "extension/node_modules/fixture/license";
  const result = await licenseInventory(candidate, [manifest, license]);
  assert.deepEqual(result.textOnly, [
    { package: "fixture@1", files: [license] },
  ]);
  assert.deepEqual(result.missingTexts, []);
});
