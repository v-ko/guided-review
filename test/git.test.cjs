"use strict";

const { git, isolateGitEnv } = require("./git.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { liveDiff, uncoveredCores, stageCores } = require("../out/src/spans.js");
const { readWorking } = require("../out/src/git.js");

test("isolation removes every inherited Git variable case-insensitively and keeps system variables", () => {
  const env = {
    PATH: "/bin",
    HOME: "/home/test",
    GIT_DIR: "/foreign",
    Git_Index_File: "/foreign-index",
    git_config_parameters: "'core.autocrlf'='true'",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/foreign-hooks",
    GIT_TEMPLATE_DIR: "/foreign-templates",
    GIT_CONFIG_SYSTEM: "/foreign-config",
  };
  assert.equal(isolateGitEnv(env), env);
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/home/test",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: "",
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  });
});

test("poisoned worker redirects/config are removed before real diffing and staging of the own repository", async (t) => {
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "guided-code-review-git-env-")),
  );
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const [root, decoy, templates] = ["repo", "decoy", "templates"].map((name) =>
    path.join(temporary, name),
  );
  for (const directory of [root, decoy, templates]) await fs.mkdir(directory);
  git(decoy, "init", "-b", "main");
  await fs.writeFile(path.join(templates, "poison-marker"), "");
  const poisonConfig = path.join(temporary, "poison.gitconfig");
  await fs.writeFile(poisonConfig, "[core]\n\tautocrlf = true\n");
  const configHome = path.join(temporary, "xdg");
  await fs.mkdir(path.join(configHome, "git"), { recursive: true });
  await fs.writeFile(
    path.join(configHome, "git", "attributes"),
    "* text eol=crlf\n",
  );
  const foreignIndex = path.join(temporary, "foreign-index");
  Object.assign(process.env, {
    GIT_DIR: path.join(decoy, ".git"),
    GIT_WORK_TREE: decoy,
    GIT_INDEX_FILE: foreignIndex,
    GIT_CONFIG_GLOBAL: poisonConfig,
    GIT_CONFIG_SYSTEM: poisonConfig,
    GIT_TEMPLATE_DIR: templates,
    XDG_CONFIG_HOME: configHome,
    GIT_CONFIG_PARAMETERS: "'core.autocrlf'='true'",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.autocrlf",
    GIT_CONFIG_VALUE_0: "true",
  });
  delete process.env.GIT_CONFIG_NOSYSTEM;
  // Same call the helper makes once at worker load.
  isolateGitEnv();

  git(root, "init", "-b", "main");
  await assert.rejects(fs.access(path.join(root, ".git", "poison-marker")), {
    code: "ENOENT",
  });
  await fs.writeFile(path.join(root, "one.txt"), "base\n");
  git(root, "add", "one.txt");
  git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  await fs.writeFile(path.join(root, "one.txt"), "after\n");
  const diff = await liveDiff(root, "one.txt");
  assert.equal(diff.root, root);
  // Leaked core.autocrlf, GIT_DIR or GIT_INDEX_FILE would make staging refuse or target the decoy.
  assert.equal(
    await stageCores(diff, uncoveredCores(diff, []), async () => {}),
    true,
  );
  assert.equal(git(root, "show", ":one.txt"), "after\n");
  await assert.rejects(fs.access(foreignIndex), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(decoy, ".git", "index")), {
    code: "ENOENT",
  });
});

test("working file reads reject symlinks, escaping parents and binary content", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "guided-code-review-read-")),
  );
  try {
    await fs.writeFile(path.join(root, "one"), "text");
    try {
      await fs.symlink(path.join(root, "one"), path.join(root, "link"), "file");
      await assert.rejects(readWorking(root, "link"), /regular/);
    } catch (error) {
      if (process.platform !== "win32" || error.code !== "EPERM") throw error;
      t.diagnostic(
        "File-symlink assertion requires Windows symlink privileges; junction escape is still tested.",
      );
    }
    await fs.symlink(
      os.tmpdir(),
      path.join(root, "outside"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      readWorking(root, "outside/does-not-exist"),
      /escapes/,
    );
    await fs.writeFile(path.join(root, "binary"), Buffer.from([0, 1, 2]));
    await assert.rejects(readWorking(root, "binary"), /Binary/);
    await fs.writeFile(path.join(root, "invalid"), Buffer.from([0xff, 0xfe]));
    await assert.rejects(readWorking(root, "invalid"), /encoded data/);
    assert.deepEqual(await readWorking(root, "missing"), {
      text: null,
      mode: null,
    });
    // Case-sensitive hosts see a missing path; insensitive hosts must refuse it,
    // never treat the same on-disk file as a new case-variant index entry.
    await fs.writeFile(path.join(root, "Case.txt"), "exact");
    try {
      assert.deepEqual(await readWorking(root, "case.txt"), {
        text: null,
        mode: null,
      });
    } catch (error) {
      assert.match(error.message, /casing does not match/);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
