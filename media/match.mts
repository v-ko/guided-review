export interface Token {
  key: string;
  start: number;
  end: number;
}

export interface Match {
  /** Character ranges in the source and target text. */
  source: [number, number];
  target: [number, number];
}

export function tokenize(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    key: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/**
 * Finds a plain-text quote in rendered text, ignoring whitespace differences and,
 * like the host's quote matching, inline markup left in code blocks.
 */
export function findQuote(
  text: string,
  quote: string,
  from: number,
  minEnd = 0,
): [number, number] | undefined {
  const markup = "[*_~`]*";
  const escape = (char: string) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const words = quote
    .trim()
    .split(/\s+/)
    .map((word) => [...word].map(escape).join(markup));
  const pattern = new RegExp(words.join(`${markup}\\s+${markup}`), "gu");
  pattern.lastIndex = from;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index + m[0].length >= minEnd)
      return [m.index, m.index + m[0].length];
    pattern.lastIndex = m.index + 1;
  }
  return undefined;
}

// A single shared word is only worth marking when it is long enough to be specific.
function significant(tokens: Token[], start: number, size: number): boolean {
  return size >= 2 || (size === 1 && tokens[start].key.length >= 6);
}

// Sentence ends and block breaks on either side split a run into separately coloured pieces.
const boundary = /\n|[.!?;:]\s/;

/**
 * Deterministic word-level matching: take the longest common run of words
 * (earliest on ties), then repeat on the parts before and after it.
 * Moved text that would cross an earlier match is not matched.
 */
export function matchText(source: string, target: string): Match[] {
  const a = tokenize(source);
  const b = tokenize(target);
  const blocks: { a: number; b: number; size: number }[] = [];
  const pending: [number, number, number, number][] = [
    [0, a.length, 0, b.length],
  ];
  while (pending.length) {
    const [alo, ahi, blo, bhi] = pending.pop()!;
    let best = { a: alo, b: blo, size: 0 };
    let previous = new Array<number>(bhi - blo + 1).fill(0);
    for (let i = alo; i < ahi; i++) {
      const current = new Array<number>(bhi - blo + 1).fill(0);
      for (let j = blo; j < bhi; j++) {
        if (a[i].key !== b[j].key) continue;
        const size = previous[j - blo] + 1;
        current[j - blo + 1] = size;
        if (size > best.size && significant(a, i - size + 1, size))
          best = { a: i - size + 1, b: j - size + 1, size };
      }
      previous = current;
    }
    if (!best.size) continue;
    blocks.push(best);
    pending.push([alo, best.a, blo, best.b]);
    pending.push([best.a + best.size, ahi, best.b + best.size, bhi]);
  }
  return blocks
    .sort((x, y) => x.a - y.a)
    .flatMap((block) => {
      const matches: Match[] = [];
      let first = 0;
      for (let k = 1; k <= block.size; k++) {
        const i = block.a + k;
        const j = block.b + k;
        if (
          k < block.size &&
          !boundary.test(source.slice(a[i - 1].end, a[i].start)) &&
          !boundary.test(target.slice(b[j - 1].end, b[j].start))
        )
          continue;
        matches.push({
          source: [a[block.a + first].start, a[i - 1].end],
          target: [b[block.b + first].start, b[j - 1].end],
        });
        first = k;
      }
      return matches;
    });
}

export interface Diff {
  /** Character ranges only in the source, and only in the target. */
  removed: [number, number][];
  added: [number, number][];
}

// Words and single punctuation marks, so a changed comma shows as its own edit.
function diffTokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)].map((m) => ({
    key: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/**
 * Classic word diff over the longest common token subsequence; adjacent
 * changed tokens merge into one range. Case changes count as edits.
 */
export function diffText(source: string, target: string): Diff {
  const a = diffTokens(source);
  const b = diffTokens(target);
  // lengths[i][j]: common subsequence length of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i][j] =
        a[i].key === b[j].key
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  const keptA = new Array<boolean>(a.length).fill(false);
  const keptB = new Array<boolean>(b.length).fill(false);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i].key === b[j].key) {
      keptA[i++] = true;
      keptB[j++] = true;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
    else j++;
  }
  const ranges = (tokens: Token[], kept: boolean[]) => {
    const found: [number, number][] = [];
    tokens.forEach((token, k) => {
      if (kept[k]) return;
      const last = found[found.length - 1];
      if (last && k > 0 && !kept[k - 1]) last[1] = token.end;
      else found.push([token.start, token.end]);
    });
    return found;
  };
  return { removed: ranges(a, keptA), added: ranges(b, keptB) };
}
