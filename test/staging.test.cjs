"use strict";

// Index-writing safety of the path the Suggest view uses: liveDiff -> stageCores -> writeIndexEntry.
const { git: runGit } = require("./git.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  liveDiff,
  rangeCores,
  uncoveredCores,
  stageCores,
  staged,
} = require("../out/src/spans.js");

async function fixture(files, run, { commit = true, format = "sha1" } = {}) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "guided-code-review-stage-")),
  );
  const git = (...args) => runGit(root, "--literal-pathspecs", ...args);
  try {
    git("init", "-b", "main", `--object-format=${format}`);
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "core.autocrlf", "false");
    for (const [name, before] of Object.entries(files))
      if (before !== null) await fs.writeFile(path.join(root, name), before);
    if (commit) {
      git("add", ".");
      git("commit", "--allow-empty", "-m", "fixture");
    }
    const index = () => fs.readFile(path.join(root, ".git/index"));
    // Stages every change of a file, as approving a block that shows all of it does.
    async function approve(file, revalidate = async () => {}, ensureActive) {
      const diff = await liveDiff(root, file);
      return stageCores(
        diff,
        uncoveredCores(diff, []),
        revalidate,
        ensureActive,
      );
    }
    async function leftovers() {
      const names = await fs.readdir(path.join(root, ".git"));
      return names.filter(
        (name) =>
          name === "index.lock" || name.startsWith("guidedcodereview-index-"),
      );
    }
    await run({ root, git, index, approve, leftovers });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("on an unborn branch, approvals stage new files, keep other entries, and refuse once HEAD appears", async () => {
  for (const format of ["sha1", "sha256"]) {
    await fixture(
      { "new.txt": "new.txt\n", "other.txt": "other\n" },
      async ({ root, git, index, approve, leftovers }) => {
        assert.equal(await approve("new.txt"), true);
        assert.equal(git("show", ":new.txt"), "new.txt\n");
        // Unrelated staged entries stay as they are.
        git("add", "other.txt");
        const other = git("rev-parse", ":other.txt");
        const before = await index();
        // Approving again changes nothing, not even the index bytes.
        assert.equal(await approve("new.txt"), false);
        assert.deepEqual(await index(), before);
        assert.equal(git("rev-parse", ":other.txt"), other);
        // A first commit while the reader approves makes the shown diff wrong.
        await fs.writeFile(path.join(root, "new.txt"), "changed\n");
        await assert.rejects(
          approve("new.txt", async () => {
            const tree = git(
              "hash-object",
              "-t",
              "tree",
              "-w",
              "/dev/null",
            ).trim();
            git(
              "update-ref",
              "HEAD",
              git("commit-tree", tree, "-m", "first").trim(),
            );
          }),
          /HEAD moved/,
        );
        assert.equal(git("show", ":new.txt"), "new.txt\n");
        assert.deepEqual(await leftovers(), []);
      },
      { commit: false, format },
    );
  }
});

test("staging status recognizes an anchored excerpt when Git aligns its blank boundary elsewhere", async () => {
  const selected = "\nfunction approved() {\n  return 2;\n}\n";
  const indexed = "start\n" + selected;
  const working = "start\n\nfunction omitted() {\n  return 1;\n}\n" + selected;
  await fixture(
    { "example.ts": indexed },
    async ({ root, git, index }) => {
      // Stage one complete excerpt, then leave a neighboring function unstaged.
      git("add", "example.ts");
      await fs.writeFile(path.join(root, "example.ts"), working);
      const diff = await liveDiff(root, "example.ts");
      const approved = rangeCores(diff, ["6-9"]).cores;
      const omitted = rangeCores(diff, ["2-5"]).cores;
      const original = await index();
      assert.equal(await staged(diff, approved), true);
      assert.equal(await staged(diff, omitted), false);
      assert.deepEqual(await index(), original);

      // A missing boundary or changed body really does make the excerpt unstaged.
      for (const changed of [
        indexed.replace("\n\nfunction", "\nfunction"),
        indexed.replace("return 2", "return 3"),
      ]) {
        await fs.writeFile(path.join(root, "example.ts"), changed);
        git("add", "example.ts");
        await fs.writeFile(path.join(root, "example.ts"), working);
        assert.equal(await staged(diff, approved), false);
      }
    },
    { commit: false },
  );
});

test("staging refuses locks, stale views, racing sources, HEAD and index, and special flags, leaving the index as it was", async () => {
  await fixture(
    { "one.txt": "base\n" },
    async ({ root, git, index, approve, leftovers }) => {
      await fs.writeFile(path.join(root, "one.txt"), "after\n");
      const original = await index();
      // Another Git process holds the lock: refuse and leave its lock alone.
      await fs.writeFile(path.join(root, ".git/index.lock"), "foreign lock");
      await assert.rejects(approve("one.txt"), /locked/);
      assert.equal(
        await fs.readFile(path.join(root, ".git/index.lock"), "utf8"),
        "foreign lock",
      );
      await fs.rm(path.join(root, ".git/index.lock"));
      // The reader's view went stale.
      await assert.rejects(
        approve("one.txt", async () => {
          throw new Error("view changed");
        }),
        /view changed/,
      );
      // The source changed after the diff was taken.
      await assert.rejects(
        approve("one.txt", async () => {
          await fs.writeFile(path.join(root, "one.txt"), "racing source\n");
        }),
        /Source changed/,
      );
      await fs.writeFile(path.join(root, "one.txt"), "after\n");
      // HEAD moved after the diff was taken.
      const head = git("rev-parse", "HEAD").trim();
      await assert.rejects(
        approve("one.txt", async () => {
          git(
            "update-ref",
            "HEAD",
            git(
              "commit-tree",
              "HEAD^{tree}",
              "-p",
              "HEAD",
              "-m",
              "racing",
            ).trim(),
          );
        }),
        /HEAD moved/,
      );
      git("update-ref", "HEAD", head);
      assert.deepEqual(await index(), original);
      // A writer that ignores index.lock changes the index meanwhile.
      await assert.rejects(
        approve("one.txt", async () => {
          await fs.appendFile(path.join(root, ".git/index"), "foreign bytes");
        }),
        /index changed during/,
      );
      await fs.writeFile(path.join(root, ".git/index"), original);
      // Special index flags.
      git("update-index", "--assume-unchanged", "one.txt");
      const flagged = await index();
      await assert.rejects(approve("one.txt"), /Special index flags/);
      assert.deepEqual(await index(), flagged);
      assert.deepEqual(await leftovers(), []);
    },
  );
});

test("conversion filters and split indexes are refused without changing the index", async () => {
  await fixture(
    { "one.txt": "base\n", "new.txt": null },
    async ({ root, git, index, approve }) => {
      await fs.writeFile(path.join(root, "one.txt"), "after\n");
      await fs.writeFile(path.join(root, "new.txt"), "new\n");
      const original = await index();
      // A clean filter would run an executable: refuse before Git runs it.
      git("config", "filter.evil.clean", "false");
      await fs.writeFile(
        path.join(root, ".gitattributes"),
        "*.txt filter=evil\n",
      );
      await assert.rejects(approve("one.txt"), /filter attribute/);
      await fs.rm(path.join(root, ".gitattributes"));
      git("config", "core.autocrlf", "true");
      await assert.rejects(approve("one.txt"), /core.autocrlf/);
      git("config", "core.autocrlf", "false");
      assert.deepEqual(await index(), original);
      // Split indexes, for a tracked and for a new file.
      git("update-index", "--split-index");
      const split = await index();
      const shared = git("rev-parse", "--shared-index-path");
      for (const file of ["one.txt", "new.txt"])
        await assert.rejects(approve(file), /split index/i);
      assert.deepEqual(await index(), split);
      assert.equal(git("rev-parse", "--shared-index-path"), shared);
    },
  );
});

test("new, deleted, CRLF, EOF, executable and unusual-name files stage their literal contents", async () => {
  const unusual =
    process.platform === "win32"
      ? "space unicode-λ.txt"
      : 'space "tab\tname.txt';
  const before = {
    new: null,
    gone: "gone\n",
    crlf: "old\r\n",
    eof: "old",
    "script.sh": "before\n",
    [unusual]: "before\n",
  };
  const after = {
    new: "new\n",
    gone: null,
    crlf: "new\r\n",
    eof: "new\n",
    "script.sh": "after\n",
    [unusual]: "after\n",
  };
  await fixture(before, async ({ root, git, approve }) => {
    // An executable on a filesystem that does not track modes keeps its index mode.
    git("update-index", "--chmod=+x", "script.sh");
    git("commit", "-m", "executable");
    git("config", "core.filemode", "false");
    for (const [name, value] of Object.entries(after)) {
      if (value === null) await fs.unlink(path.join(root, name));
      else await fs.writeFile(path.join(root, name), value);
    }
    for (const name of Object.keys(after)) {
      await approve(name);
      const diff = await liveDiff(root, name);
      assert.equal(await staged(diff, uncoveredCores(diff, [])), true, name);
      if (after[name] === null)
        assert.equal(git("ls-files", "--stage", "--", name), "");
      else assert.equal(git("show", ":" + name), after[name]);
    }
    assert.match(git("ls-files", "--stage", "--", "script.sh"), /^100755 /);
    assert.match(git("ls-files", "--stage", "--", "new"), /^100644 /);
  });
});

test("linked worktrees and a missing index stage like an ordinary repository", async () => {
  await fixture(
    { "one.txt": "base\n", new: null },
    async ({ root, git, approve }) => {
      const worktree = path.join(root, "linked");
      git("worktree", "add", "-b", "linked", worktree);
      await fs.writeFile(path.join(worktree, "one.txt"), "linked after\n");
      const diff = await liveDiff(worktree, "one.txt");
      await stageCores(diff, uncoveredCores(diff, []), async () => {});
      assert.equal(runGit(worktree, "show", ":one.txt"), "linked after\n");
      assert.equal(git("show", ":one.txt"), "base\n");
      // No index file yet: staging creates one with only the approved entry.
      await fs.writeFile(path.join(root, "new"), "new\n");
      await fs.rm(path.join(root, ".git/index"));
      await approve("new");
      assert.equal(git("show", ":new"), "new\n");
      assert.equal(git("ls-files", "--stage", "--", "one.txt"), "");
    },
  );
});

test(
  "cancellation at every staging checkpoint preserves the original index",
  { timeout: 15000 },
  async () => {
    await fixture(
      { "one.txt": "base\n" },
      async ({ root, git, index, approve, leftovers }) => {
        await fs.writeFile(path.join(root, "one.txt"), "after\n");
        const original = await index();
        // Cancel successively later without depending on a fixed number of checkpoints.
        for (let cancelAt = 1; ; cancelAt++) {
          let calls = 0;
          let cancelled = false;
          try {
            await approve(
              "one.txt",
              async () => {},
              () => {
                if (++calls === cancelAt) {
                  cancelled = true;
                  throw new Error("cancelled");
                }
              },
            );
          } catch (error) {
            if (!cancelled) throw error;
          }
          assert.deepEqual(await leftovers(), []);
          if (!cancelled) {
            assert.ok(calls > 0, "Staging has cancellation checkpoints.");
            assert.equal(git("show", ":one.txt"), "after\n");
            break;
          }
          assert.deepEqual(await index(), original);
        }
      },
    );
  },
);
