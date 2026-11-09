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
