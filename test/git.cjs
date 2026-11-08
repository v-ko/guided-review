"use strict";

// Require before runtime modules: each node:test file runs in its own process, and
// runtime capture/staging inherit process.env, so isolation must happen at load.
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Git for Windows accepts /dev/null for config paths; Node's os.devNull spelling may fail.
const nullPath = "/dev/null";
// Global attributes/ignore files have an XDG default even with global config disabled.
const configHome = mkdtempSync(
  path.join(os.tmpdir(), "guided-code-review-test-config-"),
);
process.once("exit", () =>
  rmSync(configHome, { recursive: true, force: true }),
);

function isolateGitEnv(env = process.env) {
  for (const name of Object.keys(env))
    if (name.toUpperCase().startsWith("GIT_")) delete env[name];
  return Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullPath,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: "",
    XDG_CONFIG_HOME: configHome,
  });
}

function git(root, ...args) {
  return execFileSync("git", ["-c", `core.hooksPath=${nullPath}`, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 15000,
  });
}

isolateGitEnv();

module.exports = { git, isolateGitEnv };
