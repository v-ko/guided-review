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
    let warning = "";
    if (approvable) {
      if (block.diff && block.cores) {
        try {
          state = await staged(block.diff, block.cores);
          if (!state) warning = "These changes are no longer staged.";
        } catch (error) {
          warning = `Staging could not be verified: ${(error as Error).message}`;
        }
      } else {
        warning = `Staging could not be verified. ${block.problems.join(" ")} Remove approval and review the current changes again.`;
      }
    }
    const label = !approvable
      ? "Recorded approval"
      : state === true
        ? "✓ Approved &amp; staged"
        : state === false
          ? "Not staged"
          : "Staging not verified";
    const actions = `<button class="reviewed" disabled>${label}</button>${
      approvable
        ? '<button data-action="unapprove" class="secondary" title="Remove the approval mark from the document">Remove approval</button>'
        : ""
    }`;
    return `${open}<header>${title}<div class="actions">${actions}</div></header>${warning ? notice("stale", warning) : ""}${await approvedHtml(block.approved.text, ref.file, context, titles)}</section>`;
  }
  if (block.problems.length)
    return `${open}<header>${title}</header>${notice("stale", `Outdated: ${block.problems.join(" ")} Ask the agent to capture the spans again.`)}</section>`;
  const approve = approvable
    ? '<div class="actions"><button data-action="approve" title="Stage only the changes this block shows">Approve &amp; stage</button></div>'
    : "";
  return `${open}<header>${title}${approve}</header>${block.notes.map((note) => notice("note", note)).join("")}${await highlightedHtml(ref.file, block.diff!.base, block.diff!.working, block.groups!, context, true, titles)}</section>`;
}
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
