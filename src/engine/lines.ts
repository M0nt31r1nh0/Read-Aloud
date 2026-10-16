// Fragments -> text lines. A "line" never crosses a column gutter: runs on
// the same baseline are split wherever the horizontal gap is wider than a
// word space could plausibly be.

import { centerX, fragmentBox, right, union } from './geometry';
import { printedText } from './text';
import type { Fragment, Line } from './types';

/** Gap (in ems) above which two runs on one baseline are different lines. */
const COLUMN_GAP_EM = 0.8;
const SECTION_NUMBER = /^(?:[1-9]\d?(?:\.\d{1,2}){0,3}\.?|[IVX]+\.|[A-Z]\.\d*)$/;

export function buildLines(fragments: Fragment[]): Line[] {
  const sorted = [...fragments].sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const clusters: Fragment[][] = [];
  for (const f of dedupe(sorted)) {
    const cluster = clusters[clusters.length - 1];
    if (cluster && Math.abs(f.baseline - cluster[0].baseline) <= 0.3 * Math.min(f.fontSize, cluster[0].fontSize)) {
      cluster.push(f);
    } else {
      clusters.push([f]);
    }
  }

  const lines: Line[] = [];
  for (const cluster of clusters) {
    cluster.sort((a, b) => a.x - b.x);
    let current: Fragment[] = [];
    for (const f of cluster) {
      const prev = current[current.length - 1];
      if (prev && f.x - right(fragmentBox(prev)) > COLUMN_GAP_EM * Math.max(prev.fontSize, f.fontSize)) {
        lines.push(makeLine(current));
        current = [];
      }
      current.push(f);
    }
    if (current.length) lines.push(makeLine(current));
  }
  // Two passes: second-level indices attach once first-level ones have.
  return attachFractions(rejoinRows(attachScripts(attachScripts(lines))));
}

/** Some generators draw text twice with a tiny offset to fake bold. */
function dedupe(sorted: Fragment[]): Fragment[] {
  const kept: Fragment[] = [];
  for (const f of sorted) {
    let duplicate = false;
    for (let i = kept.length - 1; i >= 0; i--) {
      const k = kept[i];
      if (f.baseline - k.baseline > 0.2 * f.fontSize) break;
      if (k.text === f.text && Math.abs(k.x - f.x) < 0.2 * f.fontSize) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) kept.push(f);
  }
  return kept;
}

/**
 * Small raised or lowered runs (footnote marks, indices such as GPU_j) end up
 * on their own baseline. Attach each run to the body line it sits on, marked
 * as a super- or subscript. Runs are matched one by one, because a row of
 * indices can stretch across a whole line ("j  k  i").
 */
function attachScripts(lines: Line[]): Line[] {
  const touched = new Set<Line>();
  const emptied = new Set<Line>();
  for (const small of lines) {
    const left: Fragment[] = [];
    for (const f of small.fragments) {
      const body = hostFor(f, small, lines, emptied);
      if (!body) {
        left.push(f);
        continue;
      }
      body.fragments.push({ ...f, script: f.baseline < body.baseline ? 'super' : 'sub' });
      // Grow the box now so nested indices (x^{a_b}) can find this line.
      body.box = union([body.box, fragmentBox(f)]);
      touched.add(body);
    }
    if (left.length === 0) emptied.add(small);
    else if (left.length < small.fragments.length) Object.assign(small, makeLine(left));
  }
  for (const body of touched) {
    body.fragments.sort((a, b) => a.x - b.x);
    body.box = union(body.fragments.map(fragmentBox));
  }
  return lines.filter((l) => !emptied.has(l));
}

function hostFor(f: Fragment, own: Line, lines: Line[], emptied: Set<Line>): Line | null {
  // Scripts are marks and indices, not phrases ("5 minutes" is a numerator).
  if (f.width > 8 * f.fontSize || /[\p{L}\p{N}]\s+\p{L}/u.test(f.text)) return null;
  let best: Line | null = null;
  let bestDistance = Infinity;
  for (const body of lines) {
    if (body === own || emptied.has(body) || body.page !== f.page || body.fontSize < f.fontSize * 1.25) continue;
    const near = f.x <= right(body.box) + 1.2 * body.fontSize && f.x + f.width >= body.box.x - 0.5 * body.fontSize;
    const dy = f.baseline - body.baseline;
    if (!near || dy < -0.75 * body.fontSize || dy > 0.55 * body.fontSize) continue;
    if (Math.abs(dy) < bestDistance) {
      best = body;
      bestDistance = Math.abs(dy);
    }
  }
  return best;
}

/**
 * Inline stacked fractions: a short numerator and denominator stacked around
 * the baseline of a text line, directly left or right of it. They are merged
 * into that line as "numerator over denominator".
 */
function attachFractions(lines: Line[]): Line[] {
  const used = new Set<Line>();
  const short = (l: Line) => l.box.w < 8 * l.fontSize;
  for (const top of lines) {
    if (used.has(top) || !short(top)) continue;
    for (const bottomLine of lines) {
      if (bottomLine === top || used.has(bottomLine) || bottomLine.page !== top.page || !short(bottomLine)) continue;
      const fs = Math.max(top.fontSize, bottomLine.fontSize);
      const gap = bottomLine.baseline - top.baseline;
      // Centred over each other and far enough apart; stacked super- and
      // subscripts ("Demand^GPU_j") sit closer together.
      const centred = Math.abs(centerX(top.box) - centerX(bottomLine.box)) <= 0.6 * fs;
      if (gap < 0.85 * fs || gap > 2.2 * fs || !centred) continue;
      const x0 = Math.min(top.box.x, bottomLine.box.x);
      const x1 = Math.max(right(top.box), right(bottomLine.box));
      const between = (m: Line) =>
        m !== top &&
        m !== bottomLine &&
        !used.has(m) &&
        m.page === top.page &&
        m.fontSize >= fs &&
        m.baseline > top.baseline + 0.25 * m.fontSize &&
        m.baseline < bottomLine.baseline - 0.25 * m.fontSize;
      // Text before and/or after the fraction on the same line.
      const before = lines.find((m) => between(m) && right(m.box) <= x0 + 2 && x0 - right(m.box) <= m.fontSize);
      const after = lines.find((m) => between(m) && m.box.x >= x1 - 2 && m.box.x - x1 <= m.fontSize);
      const host = before ?? after;
      if (!host) continue;
      // Fraction parts are at least ~70% of the text size and set off by a
      // space; second-level indices are smaller and hug their base symbol.
      if (Math.min(top.fontSize, bottomLine.fontSize) < 0.7 * host.fontSize) continue;
      // ...and smaller than the text around them; same-size stacked text is
      // table cells or display layout, not an inline fraction.
      if (Math.max(top.fontSize, bottomLine.fontSize) > 0.92 * host.fontSize) continue;
      if (before && x0 - right(before.box) < 0.15 * before.fontSize) continue;
      const barY = (top.box.y + top.box.h + bottomLine.box.y) / 2;
      const word = ' over ';
      const over: Fragment = {
        page: top.page,
        text: word,
        x: x0,
        top: barY - 1,
        width: x1 - x0,
        height: 2,
        baseline: host.baseline,
        fontSize: host.fontSize,
        fontName: host.fontName,
        chars: [...word].map((_, i) => ({ x: x0 + ((x1 - x0) * i) / word.length, y: barY - 1, w: (x1 - x0) / word.length, h: 2 })),
      };
      // Fragment order is reading order here, not x order.
      host.fragments = [
        ...(before?.fragments ?? []),
        ...top.fragments,
        over,
        ...bottomLine.fragments,
        ...(after?.fragments ?? []),
      ];
      host.box = union([before?.box, after?.box, top.box, bottomLine.box].filter((b) => b !== undefined));
      if (before && after) used.add(after);
      used.add(top).add(bottomLine);
      break;
    }
  }
  return lines.filter((l) => !used.has(l));
}

/**
 * A superscript between two words ("Ghazali¹ and Wan") leaves a gap wide
 * enough to split the row. Once the script is attached, rejoin the pieces.
 */
function rejoinRows(lines: Line[]): Line[] {
  const sorted = [...lines].sort((a, b) => a.page - b.page || a.baseline - b.baseline || a.box.x - b.box.x);
  const out: Line[] = [];
  for (const line of sorted) {
    const prev = out[out.length - 1];
    // A bare section number ("4.2.1") is set a quad away from its title.
    const maxGap = prev && SECTION_NUMBER.test(printedText(prev)) ? 2 : COLUMN_GAP_EM;
    const sameRow =
      prev &&
      prev.page === line.page &&
      Math.abs(prev.baseline - line.baseline) <= 0.3 * Math.min(prev.fontSize, line.fontSize) &&
      line.box.x >= prev.box.x &&
      line.box.x - right(prev.box) <= maxGap * Math.max(prev.fontSize, line.fontSize);
    if (sameRow) {
      prev.fragments.push(...line.fragments);
      prev.fragments.sort((a, b) => a.x - b.x);
      prev.box = union([prev.box, line.box]);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** A line built from the given fragments (baseline and font from the longest). */
export function makeLine(fragments: Fragment[]): Line {
  // The run with the most characters defines the line's baseline and font.
  const main = fragments.reduce((a, b) => (b.text.length > a.text.length ? b : a));
  return {
    page: main.page,
    fragments,
    box: union(fragments.map(fragmentBox)),
    baseline: main.baseline,
    fontSize: main.fontSize,
    fontName: main.fontName,
  };
}
