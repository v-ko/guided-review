import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { MAX_TEXT_BYTES, type FileMode, type WorkingFile } from "./git.js";

const execute = promisify(
  execFileCallback,
) as typeof execFileCallback.__promisify__;

interface GitOptions {
  input?: string | Buffer;
  index?: string;
  accepted?: number[];
  binary?: boolean;
}

export interface IndexedFile extends WorkingFile {
  oid: string | null;
}
interface StageResult {
  changed: boolean;
}

function git(
  root: string,
  args: string[],
  options?: GitOptions & { binary?: false },
): Promise<string>;
function git(
  root: string,
  args: string[],
  options: GitOptions & { binary: true },
): Promise<Buffer>;
function git(
  root: string,
  args: string[],
  options: GitOptions,
): Promise<string | Buffer>;
async function git(
  root: string,
  args: string[],
  { input, index, accepted = [0], binary = false }: GitOptions = {},
): Promise<string | Buffer> {
  const task = execute(
    "git",
    [
      "--no-optional-locks",
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd: root,
      encoding: binary ? null : "utf8",
      timeout: 15000,
      maxBuffer: MAX_TEXT_BYTES,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        ...(index ? { GIT_INDEX_FILE: index } : {}),
      },
    },
  );
  if (input !== undefined) task.child.stdin!.end(input);
  try {
    return (await task).stdout;
  } catch (error) {
    const failure = error as ExecFileException & {
      stdout: string | Buffer;
      stderr: string | Buffer;
    };
    if (typeof failure.code === "number" && accepted.includes(failure.code))
      return failure.stdout;
    throw new Error(
      `Git ${args[0]} failed: ${failure.stderr || failure.message}`,
    );
  }
}

export function sourceLines(text: string | null): string[] {
  const lines = (text ?? "").match(/[^\n]*\n|[^\n]+$/g);
  return lines ?? [];
}

export async function readIndex(
  root: string,
  filename: string,
  index?: string,
): Promise<IndexedFile> {
  const raw = await git(root, ["ls-files", "--stage", "-z", "--", filename], {
    index,
  });
  const entries = raw.split("\0").filter(Boolean);
  if (!entries.length) return { text: null, mode: null, oid: null };
  if (entries.length !== 1)
    throw new Error("Resolve merge conflicts before approving this file.");
  const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t/.exec(entries[0]);
  if (!match || entries[0].slice(match[0].length) !== filename)
    throw new Error("Only ordinary stage-zero index entries can be approved.");
  const debug = await git(root, ["ls-files", "--debug", "--", filename], {
    index,
  });
  const flags = /flags: ([\da-f]+)/i.exec(debug);
  if (!flags || Number.parseInt(flags[1], 16) !== 0)
    throw new Error(
      "Special index flags (split index, sparse, intent-to-add or assume-unchanged) are unsupported.",
    );
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(await git(root, ["cat-file", "blob", match[2]], { binary: true }));
  if (text.includes("\0"))
    throw new Error("Binary index content is unsupported.");
  // The stage-zero entry regexp validates the supported modes.
  return { mode: match[1] as FileMode, oid: match[2], text };
}

export async function checkFilters(
  root: string,
  filename: string,
): Promise<void> {
  const autocrlf = (
    await git(root, ["config", "--get", "core.autocrlf"], { accepted: [0, 1] })
  ).trim();
  if (autocrlf && autocrlf !== "false")
    throw new Error(
      "Approval staging does not support core.autocrlf conversion.",
    );
  for (const cached of [[], ["--cached"]]) {
    const attributes = (
      await git(root, [
        "check-attr",
        ...cached,
        "-z",
        "filter",
        "text",
        "eol",
        "working-tree-encoding",
        "ident",
        "--",
        filename,
      ])
    ).split("\0");
    for (let index = 0; index + 2 < attributes.length; index += 3) {
      if (!["unspecified", "unset"].includes(attributes[index + 2]))
        throw new Error(
          `Approval staging does not support the ${attributes[index + 1]} attribute on this file.`,
        );
    }
  }
}

export interface IndexChecks {
  /** Runs once the new entry is in the temporary index, before the real index is compared. */
  before(): Promise<void>;
  /** Runs last before the temporary index replaces the real one. */
  after(): Promise<void>;
  ensureActive(): void;
}

/** Replaces one index entry through a locked temporary index, leaving every other entry as it is. */
export async function writeIndexEntry(
  root: string,
  filename: string,
  decide: (indexed: IndexedFile) => Promise<WorkingFile>,
  checks: IndexChecks,
): Promise<StageResult> {
  const indexPath = path.resolve(
    root,
    (await git(root, ["rev-parse", "--git-path", "index"])).trim(),
  );
  const parent = await fs.realpath(path.dirname(indexPath));
  if (path.dirname(indexPath) !== parent)
    throw new Error("Symlinked Git index directories are unsupported.");
  const stat = await fs.lstat(indexPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (stat && (!stat.isFile() || stat.isSymbolicLink()))
    throw new Error("Only a regular Git index can be updated.");
  const lockPath = indexPath + ".lock";
  let lock: fs.FileHandle | null;
  try {
    lock = await fs.open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "Git index is locked by another operation. Retry after it finishes.",
      );
    throw error;
  }
  const temporary = path.join(
    parent,
    `guidedcodereview-index-${crypto.randomUUID()}`,
  );
  let published = false;
  try {
    const original = await fs.readFile(indexPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (original)
      await fs.writeFile(temporary, original, { mode: 0o600, flag: "wx" });
    else await git(root, ["read-tree", "--empty"], { index: temporary });
    if (
      (
        await git(root, ["rev-parse", "--shared-index-path"], {
          index: temporary,
        })
      ).trim()
    ) {
      throw new Error("Split indexes are unsupported. Nothing was staged.");
    }
    const indexed = await readIndex(root, filename, temporary);
    function others(raw: string): string {
      return raw
        .split("\0")
        .filter(
          (entry) => entry && entry.slice(entry.indexOf("\t") + 1) !== filename,
        )
        .join("\0");
    }
    const originalEntries = others(
      await git(root, ["ls-files", "--stage", "-z"], { index: temporary }),
    );
    const { text, mode } = await decide(indexed);
    const unchanged = text === indexed.text && mode === indexed.mode;
    if (!unchanged) {
      const oid =
        mode === null
          ? "0".repeat(
              (
                await git(root, ["rev-parse", "--show-object-format"])
              ).trim() === "sha256"
                ? 64
                : 40,
            )
          : (
              await git(
                root,
                ["hash-object", "-w", "--stdin", "--no-filters"],
                {
                  input: Buffer.from(text!),
                },
              )
            ).trim();
      await git(root, ["update-index", "-z", "--index-info"], {
        index: temporary,
        input: `${mode ?? "0"} ${oid}\t${filename}\0`,
      });
      const result = await readIndex(root, filename, temporary);
      if (result.text !== text || result.mode !== mode)
        throw new Error(
          "The temporary Git index does not match the approved content.",
        );
      if (
        others(
          await git(root, ["ls-files", "--stage", "-z"], {
            index: temporary,
          }),
        ) !== originalEntries
      ) {
        throw new Error(
          "Staging would change another index entry. Nothing was staged.",
        );
      }
    }
    await checks.before();
    const current = await fs.readFile(indexPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (
      (original === null) !== (current === null) ||
      (original && !original.equals(current!))
    )
      throw new Error(
        "Git index changed during approval. Nothing was staged by this operation.",
      );
    await checkFilters(root, filename);
    await checks.after();
    checks.ensureActive();
    if (!unchanged) {
      await lock.writeFile(await fs.readFile(temporary));
      await lock.sync();
      await lock.close();
      lock = null;
      // Publication is the commit point. Cancellation before rename leaves the
      // real index untouched; after it starts, successful staging is recorded.
      checks.ensureActive();
      await fs.rename(lockPath, indexPath);
      published = true;
    }
    return { changed: !unchanged };
  } finally {
    await lock?.close();
    if (!published) await fs.rm(lockPath, { force: true });
    await fs.rm(temporary, { force: true });
    await fs.rm(temporary + ".lock", { force: true });
  }
}
