// Reading order for one page.
//
// 1. Cut the page into horizontal slabs wherever there is vertical white
//    space across the whole page width.
// 2. Find vertical gutters (white space between text on both sides) in each
//    slab.
// 3. Re-join neighbouring slabs that do not cross a gutter into one column
//    region. Plain XY-cut skips this step and, when paragraph breaks line up
//    in both columns, reads left-top, right-top, left-bottom, right-bottom.
// 4. Read each region column by column (recursively, for nested layouts) and
//    full-width slabs top to bottom.

import { bottom, centerX, median, right, union } from './geometry';
import type { Block, Line } from './types';

interface Gutter {
  start: number;
  end: number;
}

const MAX_DEPTH = 2;

export function orderLines(lines: Line[], page: number): { ordered: Line[]; blocks: Block[] } {
  const ordered: Line[] = [];
  const blocks: Block[] = [];
  const emit = (group: Line[], kind: Block['kind']) => {
    if (group.length === 0) return;
    const order = blocks.length;
    blocks.push({ page, order, kind, box: union(group.map((l) => l.box)) });
    for (const line of readingSort(group)) {
      line.block = order;
      ordered.push(line);
    }
  };
  layoutRegion(lines, 0, emit);
  return { ordered, blocks };
}

function layoutRegion(lines: Line[], depth: number, emit: (lines: Line[], kind: Block['kind']) => void) {
  const slabs = cutSlabs(lines);
  const gutters = slabs.map(findGutters);

  // Grow a column region around every slab that has a gutter.
  const owner = new Array<number>(slabs.length).fill(-1);
  const regions: { from: number; to: number; gutters: Gutter[] }[] = [];
  for (let i = 0; i < slabs.length; i++) {
    if (owner[i] !== -1 || gutters[i].length === 0) continue;
    let g = gutters[i];
    let from = i;
    let to = i;
    while (from > 0 && owner[from - 1] === -1 && fitsGutters(slabs[from - 1], g)) g = narrow(g, gutters[--from]);
    while (to < slabs.length - 1 && owner[to + 1] === -1 && fitsGutters(slabs[to + 1], g)) g = narrow(g, gutters[++to]);
    for (let k = from; k <= to; k++) owner[k] = regions.length;
    regions.push({ from, to, gutters: g });
  }

  const kind: Block['kind'] = depth > 0 ? 'column' : 'full';
  let pendingFull: Line[] = [];
  let i = 0;
  while (i < slabs.length) {
    if (owner[i] === -1) {
      pendingFull.push(...slabs[i]);
      i++;
      continue;
    }
    emit(pendingFull, kind);
    pendingFull = [];
    const region = regions[owner[i]];
    const regionLines = slabs.slice(region.from, region.to + 1).flat();
    for (const column of splitColumns(regionLines, region.gutters)) {
      if (depth + 1 < MAX_DEPTH) layoutRegion(column, depth + 1, emit);
      else emit(column, 'column');
    }
    i = region.to + 1;
  }
  emit(pendingFull, kind);
}

/** Horizontal cuts at vertical white space taller than half a line. */
function cutSlabs(lines: Line[]): Line[][] {
  const sorted = [...lines].sort(byTop);
  const minGap = 0.5 * median(sorted.map((l) => l.box.h), 10);
  const slabs: Line[][] = [];
  let slabBottom = -Infinity;
  for (const line of sorted) {
    if (slabs.length && line.box.y <= slabBottom + minGap) {
      slabs[slabs.length - 1].push(line);
      slabBottom = Math.max(slabBottom, bottom(line.box));
    } else {
      slabs.push([line]);
      slabBottom = bottom(line.box);
    }
  }
  return slabs;
}

/** Vertical white space with real text columns on both sides. */
function findGutters(slab: Line[]): Gutter[] {
  if (slab.length < 4) return [];
  const fontSize = median(slab.map((l) => l.fontSize), 10);
  const spans = slab.map((l) => ({ start: l.box.x, end: right(l.box) })).sort((a, b) => a.start - b.start);

  const gaps: Gutter[] = [];
  let reach = spans[0].end;
  for (const s of spans.slice(1)) {
    if (s.start > reach && s.start - reach >= fontSize) gaps.push({ start: reach, end: s.start });
    reach = Math.max(reach, s.end);
  }

  return gaps.filter((g) => {
    const left = slab.filter((l) => right(l.box) <= g.start + 0.5);
    const rightSide = slab.filter((l) => l.box.x >= g.end - 0.5);
    const isColumn = (side: Line[]) =>
      side.length >= 2 && median(side.map((l) => l.box.w), 0) >= 3 * fontSize;
    return isColumn(left) && isColumn(rightSide);
  });
}

/**
 * A slab fits a column region if none of its lines bridges a gutter. A line
 * may start inside the gutter (a reference label set left of a column whose
 * other lines use a hanging indent) without bridging it.
 */
function fitsGutters(slab: Line[], gutters: Gutter[]): boolean {
  return slab.every((l) => gutters.every((g) => !(l.box.x < g.start + 1 && right(l.box) > g.end - 1)));
}

/** Narrow each region gutter to its overlap with the slab's own gutter. */
function narrow(region: Gutter[], slab: Gutter[]): Gutter[] {
  return region.map((g) => {
    const match = slab.find((s) => s.start < g.end && s.end > g.start);
    return match ? { start: Math.max(g.start, match.start), end: Math.min(g.end, match.end) } : g;
  });
}

function splitColumns(lines: Line[], gutters: Gutter[]): Line[][] {
  const centers = gutters.map((g) => (g.start + g.end) / 2).sort((a, b) => a - b);
  const columns: Line[][] = centers.map(() => []).concat([[]]);
  for (const line of lines) {
    const index = centers.filter((c) => centerX(line.box) > c).length;
    columns[index].push(line);
  }
  return columns.filter((c) => c.length > 0);
}

const byTop = (a: Line, b: Line) => a.box.y - b.box.y || a.box.x - b.box.x;

/**
 * Top to bottom by baseline, left to right within a row. Sorting by the box
 * top would put a taller run (an equation number, a raised mark) first.
 */
function readingSort(group: Line[]): Line[] {
  const rows: Line[][] = [];
  for (const line of [...group].sort((a, b) => a.baseline - b.baseline)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(line.baseline - row[0].baseline) <= 0.5 * Math.min(line.fontSize, row[0].fontSize)) row.push(line);
    else rows.push([line]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.box.x - b.box.x));
}
