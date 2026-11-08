import * as fs from "node:fs/promises";
import * as path from "node:path";
import MarkdownIt from "markdown-it";
import { filePath } from "./git.js";
import { escape, hash } from "./util.js";
import {
  blockFingerprint,
  blockLines,
  liveDiff,
  repositoryOf,
  staged,
  type Core,
  type DiffLine,
  type FileDiff,
  type Span,
} from "./spans.js";

type Token = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];

/** What a review-diff fence in a suggest document holds. */
export interface BlockRef {
  id: string;
  /** Repository root, relative to the document's folder. */
  repo: string;
  /** Repository-relative file path. */
  file: string;
  spans: Span[];
}

/** Lines of a fence: [first, end) as markdown-it maps them. */
type Lines = [number, number];

export interface Block {
  token: number;
  fence: Lines;
  /** The indentation of the fence's opening line. */
  indent: string;
  ref?: BlockRef;
  /** Why the fence is not a valid block. */
  invalid?: string;
  /** The diff fence right after the block, embedded at approval. */
  approved?: { text: string; fence: Lines };
  root?: string;
  diff?: FileDiff;
  cores?: Core[];
  groups?: DiffLine[][];
  fingerprint?: string;
  /** Why the spans no longer show the code. */
  problems: string[];
  notes: string[];
}

export interface BlockContext {
  documentPath: string;
  /** Whether the document may show this repository. */
  allowed(root: string): Promise<boolean>;
  highlight?(
    file: string,
    text: string | null,
    wanted: Set<number>,
  ): Promise<Map<number, string>>;
  /** Last known span positions, to flag spans that jump further than the code around them changed. */
  positions?: Map<string, { start: number; size: number }>;
  /** Containing document symbol for a resolved target; absence leaves the line-range label. */
  location?(
    diff: FileDiff,
    target: NavigationTarget,
  ): Promise<string | undefined>;
}

export interface NavigationTarget {
  id: string;
  old?: [number, number];
  next?: [number, number];
  /** Working-file insertion point for a deletion. */
  workingLine: number;
}

/** Targets refer to span identities, not stale rendered line numbers. */
export function navigationTargets(block: Block): NavigationTarget[] {
  if (
    !block.ref ||
    !block.diff ||
    !block.cores ||
    !block.groups ||
    block.problems.length
  )
    return [];
  if (block.approved) {
    const fence = approvalFence(block.groups, "");
    const recorded = fence.split("\n").slice(1, -1).join("\n") + "\n";
    if (recorded !== block.approved.text) return [];
  }
  const diff = block.diff;
  const targets: NavigationTarget[] = [];
  for (const [index, [start, end]] of block.cores.entries()) {
    let group = 0;
    for (let first = start; first <= end; first++) {
      if (diff.lines[first].kind === " ") continue;
      let last = first;
      while (last < end && diff.lines[last + 1].kind !== " ") last++;
      const changes = diff.lines.slice(first, last + 1);
      const old = changes.flatMap((line) =>
        line.kind === "-" ? [line.old!] : [],
      );
      const next = changes.flatMap((line) =>
        line.kind === "+" ? [line.new!] : [],
      );
      const following = diff.lines
        .slice(last + 1)
        .find((line) => line.new !== undefined)?.new;
      const preceding = diff.lines
        .slice(0, first)
        .reverse()
        .find((line) => line.new !== undefined)?.new;
      targets.push({
        id: hash(JSON.stringify([index, block.ref.spans[index], group++])),
        ...(old.length && { old: [old[0], old.at(-1)!] as [number, number] }),
        ...(next.length && {
          next: [next[0], next.at(-1)!] as [number, number],
        }),
        workingLine: next[0] ?? following ?? (preceding ?? 0) + 1,
      });
      first = last;
    }
  }
  return targets;
}

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const count = (value: unknown, min: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min;

export function decodeBlock(value: unknown): BlockRef {
  if (!isRecord(value)) throw new Error("Expected a JSON object.");
  const { id, repo, file, spans } = value;
  if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id))
    throw new Error("id must be 1-64 letters, digits, _ or -.");
  if (typeof repo !== "string" || !repo || repo.includes("\0"))
    throw new Error("repo must be the repository path.");
  filePath(file);
  if (!Array.isArray(spans) || !spans.length || spans.length > 50)
    throw new Error("spans must list 1-50 spans.");
  return {
    id,
    repo,
    file: file as string,
    spans: spans.map((span) => {
      if (
        !isRecord(span) ||
        !count(span.before, 0) ||
        !count(span.lines, 1) ||
        !count(span.after, 0) ||
        typeof span.hash !== "string" ||
        !/^[0-9a-f]{16}$/.test(span.hash)
      )
        throw new Error("Each span needs before, lines, after and hash.");
      return {
        before: span.before,
        lines: span.lines,
        after: span.after,
        hash: span.hash,
      };
    }),
  };
}

export function parseBlocks(markdown: string): {
  tokens: Token[];
  blocks: Block[];
} {
  const tokens = md.parse(markdown, {});
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  const ids = new Set<string>();
  tokens.forEach((token, index) => {
    if (token.type !== "fence" || token.info.trim() !== "review-diff") return;
    const fence = token.map as Lines;
    const block: Block = {
      token: index,
      fence,
      indent: /^\s*/.exec(lines[fence[0]])![0],
      problems: [],
      notes: [],
    };
    try {
      // Approval inserts a fence line by line, which only works outside quotes.
      if (!/^\s*(```|~~~)/.test(lines[fence[0]]))
        throw new Error("Code blocks inside quotes are not supported.");
      block.ref = decodeBlock(JSON.parse(token.content));
      if (ids.has(block.ref.id))
        throw new Error(`Another block has the id ${block.ref.id}.`);
      ids.add(block.ref.id);
    } catch (error) {
      block.ref = undefined;
      block.invalid = (error as Error).message;
    }
    const next = tokens[index + 1];
    if (next?.type === "fence" && next.info.trim() === "diff")
      block.approved = { text: next.content, fence: next.map as Lines };
    blocks.push(block);
  });
  return { tokens, blocks };
}

/** Finds each block's spans in the live diff of its file. */
export async function resolveBlocks(
  blocks: Block[],
  context: BlockContext,
): Promise<void> {
  const diffs = new Map<string, Promise<FileDiff>>();
  const folder = path.dirname(context.documentPath);
  for (const block of blocks) {
    const ref = block.ref;
    if (!ref) continue;
    try {
      const root = await fs.realpath(path.resolve(folder, ref.repo));
      if ((await repositoryOf(root)) !== root)
        throw new Error("repo must point at the repository root.");
      if (!(await context.allowed(root)))
        throw new Error("The repository is outside the open workspace.");
      block.root = root;
      const key = `${root}\0${ref.file}`;
      if (!diffs.has(key)) diffs.set(key, liveDiff(root, ref.file));
      block.diff = await diffs.get(key)!;
    } catch (error) {
      block.problems.push((error as Error).message);
      continue;
    }
    const diff = block.diff;
    const runs: { start: number; length: number }[] = [];
    const cores: Core[] = [];
    ref.spans.forEach((span, k) => {
      const found = diff.locate(span);
      if ("problem" in found) {
        block.problems.push(`Span ${k + 1}: ${found.problem}`);
        return;
      }
      runs.push({
        start: found.start,
        length: span.before + span.lines + span.after,
      });
      cores.push(found.core);
      const key = `${context.documentPath}\0${ref.id}\0${k}`;
      const last = context.positions?.get(key);
      const size = diff.lines.length;
      if (
        last &&
        Math.abs(found.start - last.start) > Math.abs(size - last.size)
      )
        block.notes.push(
          `Span ${k + 1} moved further than the code around it changed. Check that it shows the intended change.`,
        );
      context.positions?.set(key, { start: found.start, size });
    });
    if (block.problems.length) continue;
    block.cores = cores;
    block.groups = blockLines(diff, runs, cores);
    block.fingerprint = blockFingerprint(diff, block.groups);
  }
}

/** The diff fence that marks a block approved, recording what was staged. */
export function approvalFence(groups: DiffLine[][], indent: string): string {
  const body = groups.flatMap((group) => [
    "@@",
    ...group.flatMap((line) =>
      line.eol
        ? [line.kind + line.text]
        : [line.kind + line.text, "\\ No newline at end of file"],
    ),
  ]);
  const longest = Math.max(
    0,
    ...body.map((line) => /^\s*(`*)/.exec(line)![1].length),
  );
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return [`${ticks}diff`, ...body, ticks]
    .map((line) => indent + line)
    .join("\n");
}

/** Inserts or removes a block's approval fence; returns the document unchanged if there is nothing to do. */
export function setApproval(
  markdown: string,
  id: string,
  groups: DiffLine[][] | undefined,
): string {
  const block = parseBlocks(markdown).blocks.find((b) => b.ref?.id === id);
  if (!block) throw new Error(`The document has no block ${id}.`);
  const lines = markdown.split("\n");
  if (groups) {
    if (block.approved) return markdown;
    lines.splice(block.fence[1], 0, approvalFence(groups, block.indent));
  } else {
    if (!block.approved) return markdown;
    lines.splice(
      block.approved.fence[0],
      block.approved.fence[1] - block.approved.fence[0],
    );
  }
  return lines.join("\n");
}

function lineHtml(
  kind: DiffLine["kind"],
  text: string,
  old: number | "",
  next: number | "",
  highlighted?: string,
): string {
  const name = kind === "+" ? "added" : kind === "-" ? "removed" : "context";
  return `<div class="diff-line ${name}"><span class="diff-gutter"><span class="line-number">${old}</span><span class="line-number">${next}</span></span><code>${escape(kind)}${highlighted ?? escape(text)}</code></div>`;
}

async function highlightedHtml(
  file: string,
  base: string | null,
  working: string | null,
  groups: DiffLine[][],
  context: BlockContext,
  showNumbers = true,
  titles: string[] = [],
): Promise<string> {
  const before = new Set<number>();
  const after = new Set<number>();
  for (const line of groups.flat()) {
    if (line.new === undefined) before.add(line.old!);
    else after.add(line.new);
  }
  const [oldHtml, newHtml] = context.highlight
    ? await Promise.all([
        context.highlight(file, base, before),
        context.highlight(file, working, after),
      ])
    : [new Map<number, string>(), new Map<number, string>()];
  return groups
    .map(
      (group, index) =>
        '<div class="hunk">' +
        (titles[index] ?? '<div class="hunk-title"><span>@@</span></div>') +
        group
          .map((line) =>
            lineHtml(
              line.kind,
              line.text,
              !showNumbers || line.kind === "+" ? "" : (line.old ?? ""),
              !showNumbers || line.kind === "-" ? "" : (line.new ?? ""),
              line.new === undefined
                ? oldHtml.get(line.old!)
                : newHtml.get(line.new),
            ),
          )
          .join("") +
        "</div>",
    )
    .join("");
}

async function approvedHtml(
  text: string,
  file: string,
  context: BlockContext,
  titles: string[],
): Promise<string> {
  const groups = text
    .split("\n")
    .reduce<string[][]>((groups, line) => {
      if (line.startsWith("@@") || !groups.length) groups.push([]);
      if ([" ", "-", "+"].includes(line[0])) groups.at(-1)!.push(line);
      return groups;
    }, [])
    .filter((group) => group.length);
  const html: string[] = [];
  // Approval stores excerpts, not whole files. Restart multiline state at each gap.
  for (const [index, group] of groups.entries()) {
    const before: string[] = [];
    const after: string[] = [];
    const lines = group.map((line): DiffLine => {
      const kind = line[0] as DiffLine["kind"];
      const text = line.slice(1);
      if (kind !== "+") before.push(text);
      if (kind !== "-") after.push(text);
      return {
        kind,
        text,
        eol: true,
        ...(kind !== "+" && { old: before.length }),
        ...(kind !== "-" && { new: after.length }),
      };
    });
    html.push(
      await highlightedHtml(
        file,
        before.join("\n"),
        after.join("\n"),
        [lines],
        context,
        false,
        [
          titles[index] ??
            '<div class="hunk-title"><span>@@ · Original location unavailable.</span></div>',
        ],
      ),
    );
  }
  return html.join("");
}

function notice(className: string, text: string): string {
  return `<p class="${className}" role="status">${escape(text)}</p>`;
}

async function blockHtml(
  block: Block,
  context: BlockContext,
  approvable: boolean,
): Promise<string> {
  const ref = block.ref;
  if (!ref)
    return `<section class="review-block">${notice("stale", `Invalid code block: ${block.invalid}`)}</section>`;
  const title = `<strong title="${escape(block.root ?? ref.repo)}">${escape(ref.file)}</strong>`;
  const targets = approvable ? navigationTargets(block) : [];
  const locations = await Promise.all(
    targets.map(async (target) => {
      const range = target.next ?? target.old!;
      const label = await context.location?.(block.diff!, target);
      const lines =
        range[0] === range[1] ? `${range[0]}` : `${range[0]}-${range[1]}`;
      const location = `${label ? `${label} · ` : ""}${target.next ? "lines" : "HEAD lines"} ${lines}`;
      return `<div class="diff-location"><span title="${escape(location)}">${escape(location)}</span><div class="actions"><button data-action="source" data-target="${target.id}" class="secondary">Open source</button><button data-action="diff" data-target="${target.id}" class="secondary">Open diff</button></div></div>`;
    }),
  );
  const titles =
    block.approved && !targets.length
      ? []
      : (block.groups ?? []).map((group) => {
          const range = (side: "old" | "new"): string => {
            const lines = group.filter(
              (line) => line.kind !== (side === "old" ? "+" : "-"),
            );
            const index = lines.findIndex((line) => line[side] !== undefined);
            const start = index < 0 ? 0 : lines[index][side]! - index;
            return `${start},${lines.length}`;
          };
          const heading = `@@ -${range("old")} +${range("new")} @@`;
          const navigation = targets
            .flatMap((target, index) =>
              group.some(
                (line) =>
                  (line.kind === "+" &&
                    target.next &&
                    line.new! >= target.next[0] &&
                    line.new! <= target.next[1]) ||
                  (line.kind === "-" &&
                    target.old &&
                    line.old! >= target.old[0] &&
                    line.old! <= target.old[1]),
              )
                ? [locations[index]]
                : [],
            )
            .join("");
          return `<div class="hunk-title"><span>${escape(heading)}</span>${navigation}</div>`;
        });
  const open = `<section class="review-block" data-block-id="${escape(ref.id)}"${block.fingerprint ? ` data-fingerprint="${block.fingerprint}"` : ""}>`;
  if (block.approved) {
    let state: boolean | undefined;
    if (approvable && block.diff && block.cores)
      state = await staged(block.diff, block.cores).catch(() => undefined);
    const unstaged = state === false;
    const actions = unstaged
      ? '<button data-action="unapprove" class="secondary" title="Remove the approval mark from the document">Remove approval</button>'
      : `<button class="reviewed" disabled>✓ Approved${state ? " &amp; staged" : ""}</button>`;
    return `${open}<header>${title}<div class="actions">${actions}</div></header>${unstaged ? notice("stale", "These changes are no longer staged.") : ""}${await approvedHtml(block.approved.text, ref.file, context, titles)}</section>`;
  }
  if (block.problems.length)
    return `${open}<header>${title}</header>${notice("stale", `Outdated: ${block.problems.join(" ")} Ask the agent to capture the spans again.`)}</section>`;
  const approve = approvable
    ? '<div class="actions"><button data-action="approve" title="Stage only the changes this block shows">Approve &amp; stage</button></div>'
    : "";
  return `${open}<header>${title}${approve}</header>${block.notes.map((note) => notice("note", note)).join("")}${await highlightedHtml(ref.file, block.diff!.base, block.diff!.working, block.groups!, context, true, titles)}</section>`;
}

/** Renders untrusted Markdown with code blocks from the live diff. */
export async function renderMarkdown(
  markdown: string,
  context: BlockContext,
  approvable: boolean,
): Promise<{ html: string; blocks: Block[] }> {
  const { tokens, blocks } = parseBlocks(markdown);
  await resolveBlocks(blocks, context);
  const html = new Map<number, string>();
  for (const block of blocks) {
    html.set(block.token, await blockHtml(block, context, approvable));
    if (block.approved) html.set(block.token + 1, "");
  }
  const renderer = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: false,
  }).renderer;
  const fence = renderer.rules.fence!;
  renderer.rules.fence = (list, index, options, env, self) => {
    const rendered =
      html.get(index) ??
      (list[index].info.trim() === "mermaid"
        ? `<pre class="mermaid-source">${escape(list[index].content)}</pre>`
        : fence(list, index, options, env, self));
    if (!rendered) return "";
    const block = blocks.find((block) => block.token === index);
    const source = list[index].content + (block?.approved?.text ?? "");
    return `<div class="anchor-block" data-anchor-source="${escape(source)}">${rendered}</div>`;
  };
  // Documents cannot embed remote images or navigate the page.
  renderer.rules.image = (list, index) =>
    `<span class="image-placeholder">[Image: ${escape(list[index].content)}]</span>`;
  renderer.rules.link_open = () => '<span class="document-link">';
  renderer.rules.link_close = () => "</span>";
  return { html: renderer.render(tokens, md.options, {}), blocks };
}
