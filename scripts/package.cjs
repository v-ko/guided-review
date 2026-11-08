"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const packageAPI = require("@vscode/vsce");
const root = path.resolve(__dirname, "..");

async function packageExtension() {
  const pkg = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  const packagePath = path.join(
    root,
    "dist",
    `${pkg.name}-${pkg.version}.vsix`,
  );
  await fs.mkdir(path.dirname(packagePath), { recursive: true });
  if (!pkg.repository) {
    console.warn(
      "WARNING: package.json has no repository metadata; packaging locally with vsce's allowMissingRepository option.",
    );
  }
  // createVSIX runs vscode:prepublish before collecting files, including when
  // invoked directly. Do not build again here or suppress other vsce checks.
  // .vscodeignore includes compiled 'out', CSS, skills and production dependencies.
  await packageAPI.createVSIX({
    cwd: root,
    packagePath,
    useYarn: false,
    allowMissingRepository: true,
  });
  return packagePath;
}

if (require.main === module)
  packageExtension().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { packageExtension };
