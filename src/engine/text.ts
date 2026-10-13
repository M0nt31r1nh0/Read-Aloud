// Spoken text is built as a sequence of characters that each remember the
// page box they came from. Every edit (joining lines, removing hyphens,
// expanding abbreviations) goes through these helpers so highlighting keeps
// pointing at the right place on the page.

import type { CharBox, Line } from './types';

export interface SpokenChar {
  /** Exactly one UTF-16 code unit, so string indices and array indices agree. */
  ch: string;
  box: CharBox | null;
}

export const seqText = (seq: SpokenChar[]) => seq.map((c) => c.ch).join('');

/**
 * Characters of one line, left to right, with spaces inserted at word gaps.
 * Superscripts (footnote and citation marks) are skipped; subscripts are
 * kept as separate words so "GPU_j" is read "GPU j".
 */
export function lineChars(line: Line, includeScripts = false): SpokenChar[] {
  const out: SpokenChar[] = [];
  let prev: Line['fragments'][number] | null = null;
  let spaceAfterScript = false;
  for (const f of line.fragments) {
    if (f.script === 'super' && !includeScripts) continue;
    const last = out[out.length - 1]?.ch ?? ' ';
    const startsWord = /^[\p{L}\p{N}]/u.test(f.text);
    if (f.script === 'sub' && !includeScripts) {
      if (/[\p{L}\p{N})]/u.test(last)) out.push({ ch: ' ', box: null });
    } else if (spaceAfterScript && startsWord && !/\s/.test(last)) {
      out.push({ ch: ' ', box: null });
    } else if (prev) {
      const gap = f.x - (prev.x + prev.width);
      const needsSpace =
        gap > 0.15 * Math.min(prev.fontSize, f.fontSize) &&
        !/\s/.test(last) &&
        !/^[\s.,;:!?)\]]/.test(f.text);
      if (needsSpace) out.push({ ch: ' ', box: null });
    }
    for (let i = 0; i < f.text.length; i++) {
      out.push({ ch: f.text[i], box: { page: f.page, ...f.chars[i] } });
    }
    spaceAfterScript = f.script === 'sub' && !includeScripts;
    prev = f;
  }
  return trim(out);
}

export const lineText = (line: Line) => seqText(lineChars(line));

/**
 * Replace every match of a global regex. Replacement characters inherit the
 * boxes of the characters they replace, spread proportionally.
 */
export function replaceAll(
  seq: SpokenChar[],
  pattern: RegExp,
  replacement: string | ((match: string) => string),
): SpokenChar[] {
  const text = seqText(seq);
  const out: SpokenChar[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    const source = seq.slice(start, start + m[0].length);
    const rep = typeof replacement === 'string' ? replacement : replacement(m[0]);
    out.push(...seq.slice(last, start));
    for (let i = 0; i < rep.length; i++) {
      const from = source[Math.min(source.length - 1, Math.floor((i * source.length) / rep.length))];
      out.push({ ch: rep[i], box: from?.box ?? null });
    }
    last = start + m[0].length;
  }
  out.push(...seq.slice(last));
  return out;
}

/** Unicode compatibility forms (ligatures, superscript digits) -> plain text. */
export function normalizeChars(seq: SpokenChar[]): SpokenChar[] {
  const out: SpokenChar[] = [];
  for (const c of seq) {
    if (/[­​-‍﻿]/.test(c.ch)) continue;
    const n = c.ch.normalize('NFKC');
    for (const ch of n.split('')) out.push({ ch, box: c.box });
  }
  return out;
}

export function collapseSpaces(seq: SpokenChar[]): SpokenChar[] {
  return trim(replaceAll(seq, /\s+/g, ' '));
}

function trim(seq: SpokenChar[]): SpokenChar[] {
  let a = 0;
  let b = seq.length;
  while (a < b && /\s/.test(seq[a].ch)) a++;
  while (b > a && /\s/.test(seq[b - 1].ch)) b--;
  return seq.slice(a, b);
}
