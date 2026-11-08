"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const packageAPI = require("@vscode/vsce");
const root = path.resolve(__dirname, "..");

test("official package file list includes compiled runtime, skills and production dependencies only", async () => {
  const pkg = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await fs.readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  const files = await packageAPI.listFiles({
    cwd: root,
    packageManager: packageAPI.PackageManager.Npm,
  });
  const included = new Set(files);
  const host = (await fs.readdir(path.join(root, "out", "src")))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `out/src/${name}`);
  const browser = (await fs.readdir(path.join(root, "out", "media")))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => `out/media/${name}`);
  const expected = [
    "package.json",
    "README.md",
    "LICENSE",
    "media/suggest.css",
    ...host,
    ...browser,
    "skills/guided-review/SKILL.md",
  ];
  assert.deepEqual(
    files.filter((name) => !name.startsWith("node_modules/")).sort(),
    expected.sort(),
  );
  for (const name of [
    pkg.main.replace(/^\.\//, ""),
    "out/src/suggest-host.js",
    "out/media/match.mjs",
    "out/media/theme.mjs",
    "out/media/suggest.mjs",
    "media/suggest.css",
    ...pkg.contributes.chatSkills.map((skill) =>
      skill.path.replace(/^\.\//, ""),
    ),
    "node_modules/mermaid/dist/mermaid.esm.min.mjs",
    "node_modules/vscode-oniguruma/release/onig.wasm",
  ]) {
    assert.ok(included.has(name), `missing runtime asset: ${name}`);
  }
  for (const name of Object.keys(pkg.dependencies)) {
    const manifestPath = `node_modules/${name}/package.json`;
    assert.ok(
      included.has(manifestPath),
      `missing production manifest: ${name}`,
    );
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, manifestPath), "utf8"),
    );
    assert.equal(
      manifest.version,
      lock.packages[`node_modules/${name}`].version,
    );
    // The webview loads mermaid's ESM bundle (asserted above), not its main entry.
    if (manifest.main && name !== "mermaid") {
      const main = path.posix.normalize(
        `node_modules/${name}/${manifest.main}`,
      );
      assert.ok(
        included.has(main) || included.has(`${main}.js`),
        `missing production entry point: ${main}`,
      );
    }
    assert.ok(
      files.some(
        (file) =>
          file.startsWith(`node_modules/${name}/`) &&
          /\/(?:LICENSE|LICENCE|COPYING)(?:[.-]|$)/i.test(file),
      ),
      `missing production license: ${name}`,
    );
  }
  for (const [name, item] of Object.entries(lock.packages)) {
    if (item.dev)
      assert.ok(
        !files.some((file) => file.startsWith(`${name}/`)),
        `development package included: ${name}`,
      );
  }
  for (const file of files) {
    assert.ok(
      !/\.(?:map|[cm]?ts)$|\.review\.md$|\.review\.snapshot\.json/.test(file),
      `private/source/type file included: ${file}`,
    );
    assert.ok(
      !/(?:^|\/)node_modules\/@types\//.test(file),
      `type-only package included: ${file}`,
    );
    assert.ok(
      !/(?:^|\/)\.[^/]+(?:\/|$)|(?:^|\/)(?:test|tests|scripts|examples)\//.test(
        file,
      ),
      `private/development directory included: ${file}`,
    );
  }
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(pkg.license, "GPL-3.0-only");
  assert.equal(lock.packages[""].license, pkg.license);
  assert.equal(
    pkg.devDependencies["@vscode/vsce"],
    lock.packages["node_modules/@vscode/vsce"].version,
  );
});

test("package allowlist rejects new private and development files without writing a VSIX", async (t) => {
  const cwd = await fs.mkdtemp(
    path.join(os.tmpdir(), "guided-code-review-package-"),
  );
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.copyFile(
    path.join(root, ".vscodeignore"),
    path.join(cwd, ".vscodeignore"),
  );
  const expected = [
    "package.json",
    "README.md",
    "LICENSE",
    "out/src/extension.js",
    "out/media/suggest.mjs",
    "media/suggest.css",
    "skills/guided-review/SKILL.md",
    "node_modules/runtime-fixture/package.json",
    "node_modules/runtime-fixture/LICENSE",
    "node_modules/jsonc-parser/package.json",
    "node_modules/jsonc-parser/index.js",
  ];
  const excluded = [
    "package-lock.json",
    "tsconfig.json",
    "private.txt",
    "dist/previous.vsix",
    ".aws/credentials",
    ".agents/notes.md",
    ".codex/config.json",
    ".github/workflows/check.yml",
    ".vscode/settings.json",
    "src/extension.ts",
    "test/package.test.cjs",
    "scripts/package.cjs",
    "examples/demo.review.md",
    "private/copied.js",
    "review.review.md",
    "review.review.snapshot.json",
    "review.review.snapshot.json.tmp-1",
    "out/src/extension.js.map",
    "out/src/extension.d.ts",
    "out/src/private/secret.js",
    "out/private.js",
    "out/media/suggest.mjs.map",
    "out/media/types.d.mts",
    "media/suggest.mts",
    "media/review.css",
    "media/private.json",
    "skills/private.txt",
    "skills/layout-suggest/SKILL.md",
    "skills/guided-review/private.json",
    "skills/guided-review/private/secret.js",
    "skills/guided-review/hidden.review.md",
    "skills/guided-review/hidden.review.snapshot.json",
    // Mermaid bundles its dependencies; they ship only manifests and licenses.
    "node_modules/runtime-fixture/index.js",
    "node_modules/runtime-fixture/index.d.ts",
    "node_modules/runtime-fixture/index.js.map",
    "node_modules/runtime-fixture/hidden.review.md",
    "node_modules/runtime-fixture/hidden.review.snapshot.json",
    "node_modules/runtime-fixture/.aws/credentials",
    "node_modules/runtime-fixture/test/index.js",
    "node_modules/@types/runtime-fixture/package.json",
    "node_modules/@types/runtime-fixture/index.d.ts",
    "node_modules/dev-fixture/package.json",
    "node_modules/dev-fixture/index.js",
  ];
  for (const name of [...expected, ...excluded]) {
    await fs.mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    await fs.writeFile(path.join(cwd, name), "fixture");
  }
  await fs.writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({
      name: "package-fixture",
      version: "0.6.0",
      publisher: "misli-local",
      engines: { vscode: "^1.134.0" },
      main: "./out/src/extension.js",
      activationEvents: ["onCommand:fixture.open"],
      dependencies: {
        "runtime-fixture": "1.0.0",
        "jsonc-parser": "1.0.0",
        "@types/runtime-fixture": "1.0.0",
      },
      devDependencies: { "dev-fixture": "1.0.0" },
    }),
  );
  for (const name of [
    "runtime-fixture",
    "jsonc-parser",
    "dev-fixture",
    "@types/runtime-fixture",
  ]) {
    await fs.writeFile(
      path.join(cwd, "node_modules", name, "package.json"),
      JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
    );
  }
  const files = await packageAPI.listFiles({
    cwd,
    packageManager: packageAPI.PackageManager.Npm,
  });
  assert.deepEqual(files.sort(), expected.sort());
});
