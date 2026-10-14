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

/** `bodyFont`: the document's body text size (author blocks are larger). */
export function orderLines(lines: Line[], page: number, bodyFont = median(lines.map((l) => l.fontSize), 10)): { ordered: Line[]; blocks: Block[] } {
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
  layoutRegion(lines, 0, emit, bodyFont);
  return { ordered, blocks };
}

function layoutRegion(lines: Line[], depth: number, emit: (lines: Line[], kind: Block['kind']) => void, bodyFont: number) {
  const slabs = cutSlabs(lines).flatMap(splitAtCrossingLines);
  // Author and title blocks are read across, row by row: never split into
  // columns, never joined to the columns below them.
  const title = slabs.map((slab) => isTitleBlock(slab, bodyFont));
  const gutters = slabs.map((slab, k) => (title[k] ? [] : findGutters(slab)));
  // The gutters a region keeps when slab k joins it, or null if it cannot.
  // A slab that crosses some of them can still join on the gutters it shares:
  // a table's cell gaps beside one text column end where the text below
  // starts, but the gutter between the two text columns goes on.
  const joins = (k: number, g: Gutter[]): Gutter[] | null => {
    if (title[k]) return null;
    if (fitsGutters(slabs[k], g)) return narrow(g, gutters[k]);
    const shared = g.filter((x) => gutters[k].some((s) => s.start < x.end && s.end > x.start) && fitsGutters(slabs[k], [x]));
    return shared.length ? narrow(shared, gutters[k]) : null;
  };

  // Grow a column region around every slab that has a gutter.
  const owner = new Array<number>(slabs.length).fill(-1);
  const regions: { from: number; to: number; gutters: Gutter[] }[] = [];
  for (let i = 0; i < slabs.length; i++) {
    if (owner[i] !== -1 || gutters[i].length === 0) continue;
    let g = gutters[i];
    let from = i;
    let to = i;
    for (let next: Gutter[] | null; from > 0 && owner[from - 1] === -1 && (next = joins(from - 1, g)); ) {
      g = next;
      from--;
    }
    for (let next: Gutter[] | null; to < slabs.length - 1 && owner[to + 1] === -1 && (next = joins(to + 1, g)); ) {
      g = next;
      to++;
    }
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
      if (depth + 1 < MAX_DEPTH) layoutRegion(column, depth + 1, emit, bodyFont);
      else emit(column, 'column');
    }
    i = region.to + 1;
  }
  emit(pendingFull, kind);
}

/**
 * Rows of author names and affiliations, all in a larger font than the body
 * text: centred text whose gaps can line up with the column gutter below.
 * (Figures mix in small labels; a heading is a line or two.)
 */
function isTitleBlock(slab: Line[], body: number): boolean {
  return slab.length >= 4 && slab.every((l) => l.fontSize >= 1.1 * body);
}

/** Horizontal cuts at vertical white space taller than half a line. */
function cutSlabs(lines: Line[]): Line[][] {
  const sorted = [...lines].sort(byTop);
  const slabs: Line[][] = [];
  let slabBottom = -Infinity;
  for (const line of sorted) {
    // Relative to the line's own size: a page of tiny table text must not make
    // the normal leading between body lines look like a break.
    const minGap = 0.5 * line.box.h;
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

/**
 * A full-width line (a title, a wide figure caption) set close to a
 * two-column region ends up in the same slab and hides the gutter. If a
 * gutter appears once the wide lines are ignored, split the slab at them:
 * each run of lines between wide lines becomes its own slab.
 */
function splitAtCrossingLines(slab: Line[]): Line[][] {
  if (slab.length < 6 || findGutters(slab).length) return [slab];
  // Look for the gutter among the narrower lines (a full-width abstract can be
  // many lines), allowing a few of them to cross (centred author lines).
  const x0 = Math.min(...slab.map((l) => l.box.x));
  const width = Math.max(...slab.map((l) => right(l.box))) - x0;
  const narrow = slab.filter((l) => l.box.w < 0.6 * width);
  const gutters = narrow.length >= 6 ? tolerantGutters(narrow) : [];
  if (!gutters.length) return [slab];
  // Anything reaching into the gutter: lines across it (titles) and stray
  // marks inside it (a centred page number).
  const crosses = (l: Line) => gutters.some((g) => l.box.x < g.end - 1 && right(l.box) > g.start + 1);
  const parts: Line[][] = [];
  let run: Line[] = [];
  for (const line of [...slab].sort(byTop)) {
    if (crosses(line)) {
      if (run.length) parts.push(run);
      parts.push([line]);
      run = [];
    } else run.push(line);
  }
  if (run.length) parts.push(run);
  // Only if the split really exposes a column gutter.
  return parts.some((part) => findGutters(part).length) ? parts : [slab];
}

/**
 * Gutters that some lines (up to a quarter: titles, a centred block of
 * author names and affiliations, wide captions) are allowed to cross, with
 * text columns on both sides. The caller only accepts the result if
 * splitting at the crossing lines exposes a real gutter.
 */
function tolerantGutters(slab: Line[]): Gutter[] {
  const fontSize = textSize(slab);
  const allowed = Math.max(2, Math.floor(0.25 * slab.length));
  const x0 = Math.min(...slab.map((l) => l.box.x));
  const x1 = Math.max(...slab.map((l) => right(l.box)));
  const found: Gutter[] = [];
  let run: { x: number; covered: number }[] = [];
  // Within each stretch of low coverage, the gutter is where coverage is
  // lowest: the stretch also takes in the ragged ends of the column lines.
  const close = () => {
    const least = Math.min(...run.map((r) => r.covered));
    let start: number | null = null;
    for (const r of [...run, { x: Infinity, covered: Infinity }]) {
      if (r.covered === least) start ??= r.x;
      else if (start !== null) {
        const end = Math.min(r.x, x1);
        if (end - start >= 0.6 * fontSize) found.push({ start, end });
        start = null;
      }
    }
    run = [];
  };
  for (let x = x0; x <= x1; x += 0.5) {
    const covered = slab.filter((l) => l.box.x < x && right(l.box) > x).length;
    if (covered <= allowed && x < x1) run.push({ x, covered });
    else if (run.length) close();
  }
  return found.filter((g) => {
    const text = (side: Line[]) => side.filter((l) => l.box.w >= 6 * fontSize).length >= 3;
    return text(slab.filter((l) => right(l.box) <= g.start + 0.5)) && text(slab.filter((l) => l.box.x >= g.end - 0.5));
  });
}

/**
 * The font size most of the slab's text is set in: the median weighted by
 * line width, so a figure's many tiny tick labels do not count for much.
 */
function textSize(slab: Line[]): number {
  const sorted = [...slab].sort((a, b) => a.fontSize - b.fontSize);
  const half = sorted.reduce((sum, l) => sum + l.box.w, 0) / 2;
  let seen = 0;
  for (const l of sorted) if ((seen += l.box.w) >= half) return l.fontSize;
  return median(slab.map((l) => l.fontSize), 10);
}

/** Vertical white space with real text columns on both sides. */
function findGutters(slab: Line[]): Gutter[] {
  if (slab.length < 4) return [];
  const fontSize = textSize(slab);
  const spans = slab.map((l) => ({ start: l.box.x, end: right(l.box) })).sort((a, b) => a.start - b.start);

  const gaps: Gutter[] = [];
  let reach = spans[0].end;
  for (const s of spans.slice(1)) {
    if (s.start > reach && s.start - reach >= 0.6 * fontSize) gaps.push({ start: reach, end: s.start });
    reach = Math.max(reach, s.end);
  }

  return gaps.filter((g) => {
    const left = slab.filter((l) => right(l.box) <= g.start + 0.5);
    const rightSide = slab.filter((l) => l.box.x >= g.end - 0.5);
    // A real column has text lines, even if a figure's tick labels and
    // legend entries (many short lines) sit in it too.
    const isColumn = (side: Line[]) => side.filter((l) => l.box.w >= 6 * fontSize).length >= 2;
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
