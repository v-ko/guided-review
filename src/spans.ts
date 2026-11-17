import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { filePath, git, readWorking, type FileMode } from "./git.js";
import { hash } from "./util.js";
import {
  checkFilters,
  readIndex,
  sourceLines,
  writeIndexEntry,
} from "./stage.js";

/** One line of the full diff from HEAD to the working file. */
export interface DiffLine {
  kind: " " | "-" | "+";
  text: string;
  /** False on a last line without a newline. */
  eol: boolean;
  /** 1-based line number in HEAD, for context and removed lines. */
  old?: number;
  /** 1-based line number in the working file, for context and added lines. */
  new?: number;
}

/** A run of diff lines: the core the reader approves, with context that makes the run unique. */
export interface Span {
  before: number;
  lines: number;
  after: number;
  hash: string;
}

/** Inclusive diff line indices of a span core. */
export type Core = [number, number];

/** The live diff of one file: HEAD (empty on an unborn branch) against the working file. */
export class FileDiff {
  private readonly values: [Uint32Array, Uint32Array];
  private readonly windows = new Map<number, Map<string, number[]>>();

  constructor(
    readonly root: string,
    readonly file: string,
    readonly head: string | null,
    readonly base: string | null,
    readonly baseMode: FileMode,
    readonly working: string | null,
    readonly workingMode: FileMode,
    readonly lines: DiffLine[],
  ) {
    this.values = [
      new Uint32Array(lines.length),
      new Uint32Array(lines.length),
    ];
    lines.forEach((line, index) => {
      const digest = createHash("sha256")
        .update(`${line.kind}${line.eol ? "\n" : ""}${line.text}`)
        .digest();
      this.values[0][index] = digest.readUInt32LE(0);
      this.values[1][index] = digest.readUInt32LE(4);
    });
  }

  /** Fingerprint of the run of lines starting at start. */
  fingerprint(start: number, length: number): string {
    return BASES.map((base, k) => {
      let h = 0;
      for (let i = start; i < start + length; i++)
        h = (Math.imul(h, base) + this.values[k][i]) >>> 0;
      return h.toString(16).padStart(8, "0");
    }).join("");
  }

  /** Start indices of every run with this fingerprint, found in one rolling pass per length. */
  find(length: number, fingerprint: string): number[] {
    let table = this.windows.get(length);
    if (!table) {
      table = new Map();
      const n = this.lines.length;
      if (length > 0 && length <= n) {
        const rolling = BASES.map((base, k) => {
          const values = this.values[k];
          let power = 1;
          for (let i = 1; i < length; i++) power = Math.imul(power, base) >>> 0;
          const out = new Uint32Array(n - length + 1);
          let h = 0;
          for (let i = 0; i < length; i++)
            h = (Math.imul(h, base) + values[i]) >>> 0;
          out[0] = h;
          for (let p = 1; p + length <= n; p++) {
            h = (h - Math.imul(values[p - 1], power)) >>> 0;
            h = (Math.imul(h, base) + values[p + length - 1]) >>> 0;
            out[p] = h;
          }
          return out;
        });
        for (let p = 0; p + length <= n; p++) {
          const key =
            rolling[0][p].toString(16).padStart(8, "0") +
            rolling[1][p].toString(16).padStart(8, "0");
          const starts = table.get(key);
          if (starts) starts.push(p);
          else table.set(key, [p]);
        }
      }
      this.windows.set(length, table);
    }
    return table.get(fingerprint) ?? [];
  }

  /** Builds a span for the core, growing the context until the run is unique. */
  span(core: Core): Span | undefined {
    const [s, e] = core;
    const n = this.lines.length;
    for (let context = 3; context <= 200; context++) {
      const before = Math.min(context, s);
      const after = Math.min(context, n - 1 - e);
      const length = before + e - s + 1 + after;
      const fingerprint = this.fingerprint(s - before, length);
      if (this.find(length, fingerprint).length === 1)
        return { before, lines: e - s + 1, after, hash: fingerprint };
      if (before === s && after === n - 1 - e) return undefined;
    }
    return undefined;
  }

  /** Where the span's core is now, or why it cannot be found. */
  locate(span: Span): { start: number; core: Core } | { problem: string } {
    const length = span.before + span.lines + span.after;
    const found = this.find(length, span.hash);
    if (!found.length)
      return { problem: "The code in this span changed or was committed." };
    if (found.length > 1)
      return { problem: `The span now matches ${found.length} places.` };
    const core: Core = [
      found[0] + span.before,
      found[0] + span.before + span.lines - 1,
    ];
    return { start: found[0], core };
  }
}

const BASES = [0x01000193, 0x5bd1e995];

function textLines(text: string): { text: string; eol: boolean }[] {
  return sourceLines(text).map((line) =>
    line.endsWith("\n")
      ? { text: line.slice(0, -1), eol: true }
      : { text: line, eol: false },
  );
}

/** Line diff of two texts with the whole file as context. */
export async function diffTexts(
  before: string,
  after: string,
): Promise<DiffLine[]> {
  if (before === after)
    return textLines(before).map((line, index) => ({
      kind: " ",
      ...line,
      old: index + 1,
      new: index + 1,
    }));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "layout-suggest-"));
  try {
    const left = path.join(temp, "before");
    const right = path.join(temp, "after");
    await fs.writeFile(left, before, { mode: 0o600 });
    await fs.writeFile(right, after, { mode: 0o600 });
    const context = sourceLines(before).length + sourceLines(after).length + 1;
    const raw = await git(
      temp,
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "diff.suppressBlankEmpty=false",
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--histogram",
        `--unified=${context}`,
        "--",
        left,
        right,
      ],
      [0, 1],
    );
    const body = raw.slice(raw.search(/^@@ /m)).split("\n");
    if (body.at(-1) === "") body.pop();
    const lines: DiffLine[] = [];
    let old = 1;
    let next = 1;
    for (const line of body) {
      if (line.startsWith("@@")) continue;
      if (line.startsWith("\\")) {
        lines[lines.length - 1].eol = false;
        continue;
      }
      const kind = line[0] as DiffLine["kind"];
      lines.push({
        kind,
        text: line.slice(1),
        eol: true,
        ...(kind !== "+" && { old: old++ }),
        ...(kind !== "-" && { new: next++ }),
      });
    }
    return interleave(lines);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

/**
 * Lists each removed line of a change before the added lines that replace it: the removed lines
 * take the added lines in order, one each, and the last removed line takes the rest. Spans,
 * blocks and staging all use this order, so a block stages the lines in the order it shows them.
 */
function interleave(lines: DiffLine[]): DiffLine[] {
  const result: DiffLine[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind === " ") {
      result.push(lines[i++]);
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    for (; i < lines.length && lines[i].kind !== " "; i++)
      (lines[i].kind === "-" ? removed : added).push(lines[i]);
    removed.forEach((line, k) =>
      result.push(
        line,
        ...(k === removed.length - 1 ? added.slice(k) : added.slice(k, k + 1)),
      ),
    );
    if (!removed.length) result.push(...added);
  }
  return result;
}

/** The repository root containing an absolute path. */
export async function repositoryOf(target: string): Promise<string> {
  const stat = await fs.stat(target).catch(() => undefined);
  const directory = stat?.isDirectory() ? target : path.dirname(target);
  return fs.realpath(
    (await git(directory, ["rev-parse", "--show-toplevel"])).trim(),
  );
}

export async function liveDiff(root: string, file: string): Promise<FileDiff> {
  filePath(file);
  const head =
    (
      await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1])
    ).trim() || null;
  let base: string | null = null;
  let baseMode: FileMode = null;
  if (head) {
    const tree = (await git(root, ["ls-tree", "-z", head, "--", file]))
      .split("\0")
      .filter(Boolean);
    const entry =
      tree.length === 1
        ? /^(100644|100755) blob ([a-f0-9]{40,64})\t/.exec(tree[0])
        : null;
    if (tree.length && (!entry || tree[0].slice(entry[0].length) !== file))
      throw new Error(`Only regular files are supported: ${file}`);
    if (entry) {
      base = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await git(root, ["cat-file", "blob", entry[2]], [0], null),
      );
      baseMode = entry[1] as FileMode;
    }
  }
  const working = await readWorking(root, file);
  return new FileDiff(
    root,
    file,
    head,
    base,
    baseMode,
    working.text,
    working.mode,
    await diffTexts(base ?? "", working.text ?? ""),
  );
}

const isChange = (line: DiffLine): boolean => line.kind !== " ";

/**
 * Parses ranges such as "41-42", "41" (working file lines) and "old:40" (HEAD lines) into span cores.
 * Removed lines right next to a core join it, unless the call names old lines itself.
 */
export function rangeCores(
  diff: FileDiff,
  ranges: string[],
): { cores: Core[]; problems: string[] } {
  const cores: Core[] = [];
  const problems: string[] = [];
  const explicitOld = ranges.some((range) => range.startsWith("old:"));
  for (const range of ranges) {
    const match = /^(old:)?(\d+)(?:-(\d+))?$/.exec(range.trim());
    if (!match) {
      problems.push(`Malformed range: ${range}`);
      continue;
    }
    const first = Number(match[2]);
    const last = Number(match[3] ?? match[2]);
    const selected = diff.lines.flatMap((line, index) => {
      const number = match[1] ? line.old : line.new;
      return number !== undefined && number >= first && number <= last
        ? [index]
        : [];
    });
    if (!selected.length) {
      problems.push(`Range ${range} selects no lines.`);
      continue;
    }
    let s = selected[0];
    let e = selected.at(-1)!;
    if (!explicitOld) {
      // Removed lines before a core are the lines it replaces. Removed lines after it join only
      // when no added line follows them, since then they replace nothing else.
      while (s > 0 && diff.lines[s - 1].kind === "-") s--;
      let next = e + 1;
      while (next < diff.lines.length && diff.lines[next].kind === "-") next++;
      if (next === diff.lines.length || diff.lines[next].kind === " ")
        e = next - 1;
    }
    if (!diff.lines.slice(s, e + 1).some(isChange)) {
      problems.push(`Range ${range} has no changes.`);
      continue;
    }
    cores.push([s, e]);
  }
  return { cores, problems };
}

/** Runs of changed lines outside the given cores. */
export function uncoveredCores(diff: FileDiff, covered: Core[]): Core[] {
  const inside = (index: number): boolean =>
    covered.some(([s, e]) => s <= index && index <= e);
  const runs: Core[] = [];
  diff.lines.forEach((line, index) => {
    if (!isChange(line) || inside(index)) return;
    const last = runs.at(-1);
    if (last && last[1] === index - 1) last[1] = index;
    else runs.push([index, index]);
  });
  return runs;
}

export function overlaps(a: Core, b: Core, diff: FileDiff): boolean {
  for (let i = Math.max(a[0], b[0]); i <= Math.min(a[1], b[1]); i++)
    if (isChange(diff.lines[i])) return true;
  return false;
}

/** Changed lines of the cores and the context they show in, grouped into contiguous hunks. */
export function blockLines(
  diff: FileDiff,
  runs: { start: number; length: number }[],
  cores: Core[],
): DiffLine[][] {
  const inCore = inside(cores);
  const shown = new Set<number>();
  for (const { start, length } of runs)
    for (let i = start; i < start + length; i++) shown.add(i);
  const groups: DiffLine[][] = [];
  let previous = -2;
  for (const index of [...shown].sort((a, b) => a - b)) {
    const line = diff.lines[index];
    // Other spans' added lines are not in this block's version; their removed lines still are.
    if (!inCore(index) && line.kind === "+") continue;
    if (index !== previous + 1 || !groups.length) groups.push([]);
    previous = index;
    groups
      .at(-1)!
      .push(
        inCore(index)
          ? line
          : { kind: " ", text: line.text, eol: line.eol, old: line.old },
      );
  }
  return groups;
}

export interface InspectionLine extends DiffLine {
  /** Characters omitted from the end of a long source line. */
  omittedCharacters?: number;
}

export interface CaptureInspection {
  /** Core endpoints and up to three neighboring diff lines, which are not part of the core. */
  boundaries: {
    first: InspectionLine;
    last: InspectionLine;
    preceding: InspectionLine[];
    following: InspectionLine[];
  }[];
  /** The same hunks the block renderer uses, abbreviated in the middle when needed. */
  preview: {
    head: InspectionLine[];
    omittedLines: number;
    tail: InspectionLine[];
  }[];
}

/** Shows what a capture actually selected without changing its spans or staging scope. */
export function captureInspection(
  diff: FileDiff,
  spans: Span[],
  cores: Core[],
): CaptureInspection {
  const line = (source: DiffLine): InspectionLine => ({
    ...source,
    text: source.text.slice(0, 500),
    ...(source.text.length > 500 && {
      omittedCharacters: source.text.length - 500,
    }),
  });
  const groups = blockLines(
    diff,
    spans.map((span, index) => ({
      start: cores[index][0] - span.before,
      length: span.before + span.lines + span.after,
    })),
    cores,
  );
  return {
    boundaries: cores.map(([start, end]) => ({
      first: line(diff.lines[start]),
      last: line(diff.lines[end]),
      preceding: diff.lines.slice(Math.max(0, start - 3), start).map(line),
      following: diff.lines.slice(end + 1, end + 4).map(line),
    })),
    preview: groups.map((group) => ({
      head: group.slice(0, 8).map(line),
      omittedLines: Math.max(0, group.length - 16),
      tail:
        group.length > 8
          ? group.slice(Math.max(8, group.length - 8)).map(line)
          : [],
    })),
  };
}

const lineText = (line: DiffLine): string => line.text + (line.eol ? "\n" : "");

const inside =
  (cores: Core[]) =>
  (index: number): boolean =>
    cores.some(([s, e]) => s <= index && index <= e);

/** A line of the index text: at is the diff line it is, or undefined if the working file does not have it. */
interface IndexLine {
  at?: number;
  text: string;
}

/**
 * Finds each index line in the diff, through the working file's lines and through HEAD's.
 * Where the two disagree, a context line wins, since equal lines elsewhere can mislead one diff.
 */
async function indexLines(diff: FileDiff, text: string): Promise<IndexLine[]> {
  const byNew = new Map<number, number>();
  const byOld = new Map<number, number>();
  diff.lines.forEach((line, index) => {
    if (line.new !== undefined) byNew.set(line.new, index);
    if (line.old !== undefined) byOld.set(line.old, index);
  });
  const toWorking = new Map<number, number>();
  for (const line of await diffTexts(text, diff.working ?? ""))
    if (line.kind === " ") toWorking.set(line.old!, line.new!);
  const toBase = new Map<number, number>();
  for (const line of await diffTexts(diff.base ?? "", text))
    if (line.kind === " ") toBase.set(line.new!, line.old!);
  let last = -1;
  return sourceLines(text).map((line, k) => {
    const working = toWorking.get(k + 1);
    const base = toBase.get(k + 1);
    const found = [
      working === undefined ? undefined : byNew.get(working),
      base === undefined ? undefined : byOld.get(base),
    ].filter((at) => at !== undefined);
    const at =
      found.find((index) => diff.lines[index].kind === " ") ?? found[0];
    // A line the two diffs place out of order counts as the index's own.
    if (at === undefined || at <= last) return { text: line };
    last = at;
    return { at, text: line };
  });
}

/**
 * What happens to each line of the index's own when the cores are staged. Such lines sit in the
 * gap between the found lines around them. If the gap holds a changed line of the cores and only
 * changed lines, the block replaces them: "drop". If the gap also holds context lines, the lines
 * could replace those, and their place next to the block is unknown: "conflict".
 */
function ownLines(
  diff: FileDiff,
  lines: IndexLine[],
  inCore: (index: number) => boolean,
): ("keep" | "drop" | "conflict")[] {
  const following: number[] = [];
  let next = diff.lines.length;
  for (let k = lines.length - 1; k >= 0; k--) {
    following[k] = next;
    if (lines[k].at !== undefined) next = lines[k].at!;
  }
  let previous = -1;
  return lines.map((line, k) => {
    if (line.at !== undefined) {
      previous = line.at;
      return "keep";
    }
    const gap = diff.lines.slice(previous + 1, following[k]);
    if (!gap.some((l, i) => l.kind !== " " && inCore(previous + 1 + i)))
      return "keep";
    return gap.some((l) => l.kind === " ") ? "conflict" : "drop";
  });
}

/** Whether the index holds every changed line of the cores and nothing else in their place. */
export async function staged(diff: FileDiff, cores: Core[]): Promise<boolean> {
  const inCore = inside(cores);
  const indexed = await readIndex(diff.root, diff.file);
  // A deleted working file is staged only as a deleted index entry, not as an empty file.
  if (indexed.text === null && diff.base !== null) return diff.working === null;
  if (diff.working === null && indexed.text === "") return false;
  const lines = await indexLines(diff, indexed.text ?? "");
  const present = new Set(lines.map((line) => line.at));
  for (const [start, end] of cores) {
    const expected = diff.lines.flatMap((line, at) =>
      at >= start && at <= end && line.kind !== "-"
        ? [{ at, text: lineText(line) }]
        : [],
    );
    const offsets = new Map(expected.map((line, offset) => [line.at, offset]));
    const anchors = lines.flatMap((line, index) => {
      const offset = line.at === undefined ? undefined : offsets.get(line.at);
      return offset === undefined ? [] : [{ index, offset }];
    });
    const first = anchors.length ? anchors[0].index - anchors[0].offset : -1;
    // Git can align an identical boundary line outside the core. Require the
    // complete excerpt at a position established by its already-matched lines.
    if (
      first >= 0 &&
      anchors.every((anchor) => anchor.index - anchor.offset === first) &&
      expected.every((line, k) => lines[first + k]?.text === line.text)
    )
      for (const line of expected) present.add(line.at);
  }
  return (
    diff.lines.every(
      (line, index) =>
        line.kind === " " ||
        !inCore(index) ||
        present.has(index) === (line.kind === "+"),
    ) && ownLines(diff, lines, inCore).every((fate) => fate === "keep")
  );
}

/**
 * The index text with the cores' changes: their removed lines go, their added lines come in at
 * their place in the diff, and the index's own lines between them go.
 */
function withCores(
  diff: FileDiff,
  lines: IndexLine[],
  inCore: (index: number) => boolean,
): string {
  const fates = ownLines(diff, lines, inCore);
  if (fates.includes("conflict"))
    throw new Error(
      `The index holds other changes to ${diff.file} next to these lines. Nothing was staged.`,
    );
  const present = new Set(lines.map((line) => line.at));
  const added = diff.lines.flatMap((line, index) =>
    line.kind === "+" && inCore(index) && !present.has(index) ? [index] : [],
  );
  let text = "";
  const append = (line: string): void => {
    if (text && !text.endsWith("\n"))
      throw new Error(
        `The block adds lines after the last line of ${diff.file}, which has no newline. Capture the change of that line with it.`,
      );
    text += line;
  };
  const addBefore = (limit: number): void => {
    while (added.length && added[0] < limit)
      append(lineText(diff.lines[added.shift()!]));
  };
  lines.forEach((line, k) => {
    if (line.at === undefined) {
      if (fates[k] === "keep") append(line.text);
      return;
    }
    addBefore(line.at);
    if (!(diff.lines[line.at].kind === "-" && inCore(line.at)))
      append(line.text);
  });
  addBefore(diff.lines.length);
  return text;
}

/**
 * Applies the cores' changed lines to the index and keeps its other staged changes.
 * revalidate runs while the index is locked and throws if the reader's view went stale;
 * ensureActive runs right before the index is replaced.
 */
export async function stageCores(
  diff: FileDiff,
  cores: Core[],
  revalidate: () => Promise<void>,
  ensureActive: () => void = () => {},
): Promise<boolean> {
  if (
    ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"].some(
      (key) => process.env[key],
    )
  )
    throw new Error(
      "Custom Git repository/index environment is unsupported for approval staging.",
    );
  filePath(diff.file);
  await checkFilters(diff.root, diff.file);
  const inCore = inside(cores);
  async function checkSource(): Promise<void> {
    const working = await readWorking(diff.root, diff.file);
    if (working.text !== diff.working || working.mode !== diff.workingMode)
      throw new Error("Source changed during approval. Nothing was staged.");
    const head =
      (
        await git(
          diff.root,
          ["rev-parse", "--verify", "--quiet", "HEAD"],
          [0, 1],
        )
      ).trim() || null;
    if (head !== diff.head)
      throw new Error(
        "HEAD moved since the block was shown. Refresh it. Nothing was staged.",
      );
  }
  const result = await writeIndexEntry(
    diff.root,
    diff.file,
    async (indexed) => {
      if (indexed.text === null && diff.base !== null) {
        if (diff.working === null) return { text: null, mode: null };
        throw new Error(
          `The index stages the deletion of ${diff.file}. Unstage it first.`,
        );
      }
      const text = withCores(
        diff,
        await indexLines(diff, indexed.text ?? ""),
        inCore,
      );
      if (text === "" && diff.working === null && diff.base !== null)
        return { text: null, mode: null };
      return {
        text,
        mode: indexed.mode ?? diff.workingMode ?? diff.baseMode ?? "100644",
      };
    },
    {
      async before() {
        await checkSource();
        await revalidate();
      },
      after: checkSource,
      ensureActive,
    },
  );
  return result.changed;
}

/** Identifies what a block shows, so an approval stages only what the reader saw. */
export function blockFingerprint(diff: FileDiff, groups: DiffLine[][]): string {
  return hash(JSON.stringify([diff.root, diff.file, diff.head, groups]));
}
