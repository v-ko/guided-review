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
