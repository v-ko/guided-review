import * as fs from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import type { ExecFileException } from "node:child_process";

export type FileMode = "100644" | "100755" | null;

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

export function filePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    path.posix.isAbsolute(value) ||
    (process.platform === "win32" && value.includes(":")) ||
    value
      .split("/")
      .some((p) => !p || p === ".." || p === "." || p.toLowerCase() === ".git")
  ) {
    throw new Error(`Invalid repository-relative file path: ${String(value)}`);
  }
  return value;
}

export interface WorkingFile {
  text: string | null;
  mode: FileMode;
}

const execFile = promisify(
  execFileCallback,
) as typeof execFileCallback.__promisify__;

export function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function git(
  root: string,
  args: string[],
  accepted?: number[],
  encoding?: BufferEncoding,
): Promise<string>;
export function git(
  root: string,
  args: string[],
  accepted: number[],
  encoding: null,
): Promise<Buffer>;
export function git(
  root: string,
  args: string[],
  accepted: number[] | undefined,
  encoding: BufferEncoding | null,
): Promise<string | Buffer>;
export async function git(
  root: string,
  args: string[],
  accepted: number[] = [0],
  encoding: BufferEncoding | null = "utf8",
): Promise<string | Buffer> {
  const command = [
    "--no-optional-locks",
    "--literal-pathspecs",
    "-c",
    "diff.autoRefreshIndex=false",
    ...args,
  ];
  try {
    const result = await execFile("git", command, {
      cwd: root,
      encoding,
      timeout: 15000,
      maxBuffer: MAX_TEXT_BYTES,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_ATTR_NOSYSTEM: "1" },
    });
    return result.stdout;
  } catch (error) {
    const failure = error as ExecFileException & {
      stdout: string | Buffer;
      stderr: string | Buffer;
    };
    if (
      typeof failure.code === "number" &&
      accepted.includes(failure.code) &&
      typeof failure.stdout === "string"
    )
      return failure.stdout;
    throw new Error(
      `Git ${args[0]} failed: ${failure.stderr || failure.message}`,
    );
  }
}

export async function readWorking(
  root: string,
  filename: string,
): Promise<WorkingFile> {
  const target = path.resolve(root, filename);
  if (!contained(root, target)) throw new Error("File escapes repository.");
  // Validate parents too: a missing file below an escaping symlink is not a deletion.
  let parent = path.dirname(target);
  while (contained(root, parent)) {
    try {
      if (!contained(root, await fs.realpath(parent)))
        throw new Error(`Symlink parent escapes repository: ${filename}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (parent === root) throw error;
      parent = path.dirname(parent);
    }
  }
  let stat: Stats;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { text: null, mode: null };
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !contained(root, await fs.realpath(target))
  ) {
    throw new Error(`Only regular, contained files are supported: ${filename}`);
  }
  // Git paths are case-exact even when the working filesystem is not. Do not
  // capture an existing file as a new case-variant index entry.
  let directory = root;
  for (const component of filename.split("/")) {
    if (!(await fs.readdir(directory)).includes(component))
      throw new Error(`File path casing does not match disk: ${filename}`);
    directory = path.join(directory, component);
  }
  if (stat.size > MAX_TEXT_BYTES)
    throw new Error(`File exceeds 5 MiB: ${filename}`);
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(await fs.readFile(target));
  if (text.includes("\0") || Buffer.byteLength(text) > MAX_TEXT_BYTES)
    throw new Error(`Binary/oversized file is unsupported: ${filename}`);
  let mode: FileMode = stat.mode & 0o111 ? "100755" : "100644";
  // Match Git on filesystems which cannot track executable bits. Existing files
  // retain their index mode; new files are ordinary non-executable files.
  if (
    process.platform === "win32" ||
    (
      await git(root, ["config", "--bool", "--get", "core.filemode"], [0, 1])
    ).trim() === "false"
  ) {
    const entries = (
      await git(root, ["ls-files", "--stage", "-z", "--", filename])
    )
      .split("\0")
      .filter(Boolean);
    const entry =
      entries.length === 1
        ? /^(100644|100755) [a-f0-9]{40,64} 0\t/.exec(entries[0])
        : null;
    if (
      entries.length &&
      (!entry || entries[0].slice(entry[0].length) !== filename)
    ) {
      throw new Error(
        `Only ordinary stage-zero file modes are supported: ${filename}`,
      );
    }
    mode = entry?.[1] === "100755" ? "100755" : "100644";
  }
  return { text, mode };
}
