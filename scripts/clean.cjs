// tsc never deletes outputs of removed sources, and packaging ships all of out/.
require("node:fs").rmSync(require("node:path").join(__dirname, "..", "out"), {
  recursive: true,
  force: true,
});
