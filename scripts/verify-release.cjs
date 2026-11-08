"use strict";

// Verify saved public source in an owned clean directory, never the source index.
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const root = path.resolve(__dirname, "..");
const privatePath =
  /(?:^|\/)(?:\.git|\.reviews|\.aws|\.codex|\.agents|node_modules|out|dist)(?:\/|$)|\.review\.snapshot\.json|\.vsix$/;

function verificationEnv() {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.toUpperCase().startsWith("GIT_"),
    ),
  );
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

async function copyCandidate(source, destination) {
  const options = { cwd: source, env: verificationEnv(), encoding: "utf8" };
  const git = [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.excludesFile=/dev/null",
    "ls-files",
  ];
  const ignored = await execute(
    "git",
    [...git, "--cached", "--ignored", "--exclude-standard", "-z"],
    options,
  );
  if (ignored.stdout)
    throw new Error(
      "Tracked files match ignore rules; remove private/generated files from the public candidate.",
    );
  const { stdout } = await execute(
    "git",
    [...git, "--cached", "--others", "--exclude-standard", "-z"],
    options,
  );
  const files = [...new Set(stdout.split("\0").filter(Boolean))].sort();
  if (!files.length) throw new Error("No public source candidates found.");
  await fs.mkdir(destination);
  const digests = {};
  const canonicalRoot = await fs.realpath(source);
  for (const file of files) {
    if (
      path.isAbsolute(file) ||
      file.split("/").some((part) => part === ".." || part === ".") ||
      privatePath.test(file)
    ) {
      throw new Error(`Private or invalid source candidate: ${file}`);
    }
    const filename = path.join(source, file);
    let stat;
    try {
      stat = await fs.lstat(filename);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    } // Saved deletions are absent in the candidate.
    const canonical = await fs.realpath(filename);
    const relative = path.relative(canonicalRoot, canonical);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Source candidate must be a contained regular file: ${file}`,
      );
    }
    const target = path.join(destination, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const handle = await fs.open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev
      )
        throw new Error(`Source changed during copy: ${file}`);
      const content = await handle.readFile();
      const mode = opened.mode & 0o777;
      await fs.writeFile(target, content, { flag: "wx", mode });
      if (process.platform !== "win32") await fs.chmod(target, mode);
      digests[file] = {
        hash: createHash("sha256").update(content).digest("hex"),
        mode,
      };
    } finally {
      await handle.close();
    }
  }
  return digests;
}

function checkArchiveEntries(entries, lock = { packages: {} }) {
  if (entries.length > 50000 || new Set(entries).size !== entries.length)
    throw new Error("VSIX has too many or duplicate entries.");
  const development = Object.entries(lock.packages)
    .filter(([, item]) => item.dev)
    .map(([name]) => `${name}/`);
  for (const file of entries) {
    if (file === "[Content_Types].xml" || file === "extension.vsixmanifest")
      continue;
    const relative = file.replace(/^extension\//, "");
    if (
      !file.startsWith("extension/") ||
      file.includes("\\") ||
      file.split("/").includes("..") ||
      !/^(?:package\.json|readme\.md|LICENSE\.txt|out\/src\/[^/]+\.js|out\/media\/[^/]+\.mjs|media\/suggest\.css|skills\/guided-review\/SKILL\.md|node_modules\/.+)$/.test(
        relative,
      ) ||
      development.some((prefix) => relative.startsWith(prefix)) ||
      /\.(?:map|[cm]?ts)$|\.review\.(?:md|snapshot\.json)/.test(relative) ||
      /(?:^|\/)\.[^/]+(?:\/|$)|(?:^|\/)(?:test|tests|scripts|examples)\/|(?:^|\/)node_modules\/@types\//.test(
        relative,
      )
    ) {
      throw new Error(`Unexpected or private VSIX entry: ${file}`);
    }
  }
  for (const file of [
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
  ]) {
    if (!entries.includes(file)) throw new Error(`Missing VSIX entry: ${file}`);
  }
}

async function licenseInventory(candidate, entries) {
  const licenses = {};
  const missingTexts = [];
  const textOnly = [];
  // Inspect shipped packages, not optional/type-only lock entries excluded by vsce.
  for (const file of entries.filter((name) =>
    /^extension\/(?:node_modules\/(?:@[^/]+\/)?[^/]+\/)+package\.json$/.test(
      name,
    ),
  )) {
    const relative = file.slice("extension/".length);
    const manifest = JSON.parse(
      await fs.readFile(path.join(candidate, relative), "utf8"),
    );
    const license =
      typeof manifest.license === "string"
        ? manifest.license
        : manifest.license?.type;
    const directory = file.slice(0, -"package.json".length);
    const texts = entries.filter(
      (name) =>
        name.startsWith(directory) &&
        /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[.-]|$)/i.test(
          name.slice(directory.length),
        ),
    );
    if (!license && !texts.length)
      throw new Error(
        `Shipped package has neither a license declaration nor license text: ${relative}`,
      );
    const label = license ?? "See shipped license text";
    licenses[label] = (licenses[label] ?? 0) + 1;
    if (!license)
      textOnly.push({
        package: `${manifest.name}@${manifest.version}`,
        files: texts,
      });
    if (!texts.length) {
      missingTexts.push(`${manifest.name}@${manifest.version}`);
    }
  }
  console.log(
    "VERIFY: shipped license declarations (not a legal audit):",
    licenses,
  );
  if (textOnly.length)
    console.log(
      "VERIFY: packages with license text but no manifest declaration:",
      textOnly,
    );
  if (missingTexts.length)
    console.warn(
      "VERIFY: packages without a top-level license/notice text; inspect before publication:",
      missingTexts,
    );
  return { licenses, textOnly, missingTexts };
}

function run(command, args, cwd, discardOutput = false) {
  console.log(`\nVERIFY: ${command} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: verificationEnv(),
      stdio: discardOutput ? "ignore" : "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} failed: ${code ?? signal}`)),
    );
  });
}

async function main() {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error("Run this gate with npm run verify:release.");
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "guided-code-review-release-"),
  );
  const candidate = path.join(temporary, "candidate");
  try {
    const digests = await copyCandidate(root, candidate);
    console.log(
      `VERIFY: ${Object.keys(digests).length} saved public source files; ${process.version} on ${process.platform}`,
    );
    // Audit the frozen graph before installing it. No new dependencies or install scripts.
    function runNpm(...args) {
      return run(process.execPath, [npm, ...args], candidate);
    }
    await runNpm("audit");
    await runNpm("audit", "--omit=dev");
    await runNpm("ci", "--ignore-scripts");
    await runNpm("run", "check");
    await runNpm("test");
    await runNpm("run", "package");
    const pkg = JSON.parse(
      await fs.readFile(path.join(candidate, "package.json"), "utf8"),
    );
    const archive = path.join(
      candidate,
      "dist",
      `${pkg.name}-${pkg.version}.vsix`,
    );
    // Windows includes bsdtar; Unix desktops use unzip. Stream every payload to
    // verify decompression without extracting untrusted archive paths to disk.
    const windows = process.platform === "win32";
    const archiver = windows
      ? path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "tar.exe",
        )
      : "unzip";
    await run(
      archiver,
      windows ? ["-xOf", archive] : ["-tq", archive],
      candidate,
      windows,
    );
    const { stdout } = await execute(
      archiver,
      windows ? ["-tf", archive] : ["-Z1", archive],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const entries = stdout.trim().split(/\r?\n/);
    const lock = JSON.parse(
      await fs.readFile(path.join(candidate, "package-lock.json"), "utf8"),
    );
    checkArchiveEntries(entries, lock);
    await licenseInventory(candidate, entries);
    console.log(
      `VERIFY: VSIX ${entries.length} files, ${(await fs.stat(archive)).size} bytes; integrity and private-file checks passed.`,
    );
    const current = await copyCandidate(root, path.join(temporary, "recheck"));
    if (JSON.stringify(current) !== JSON.stringify(digests))
      throw new Error(
        "Public source paths, modes or contents changed during release verification.",
      );
    console.log(
      `\nVERIFY: ${pkg.name} ${pkg.version} passed the clean ${process.platform} release gate. This result covers only this host.`,
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = {
  copyCandidate,
  checkArchiveEntries,
  licenseInventory,
  verificationEnv,
};
