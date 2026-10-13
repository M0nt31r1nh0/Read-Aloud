// Tables as speech.
//
// The lines of a table are first rebuilt into a grid of cells:
//  - bordered tables: each line's cell is the box formed by the nearest
//    ruling lines around it, so multi-line cells merge and spanning cells
//    ("Scope of resource allocation" over three rows) span correctly;
//  - tables without vertical rules (booktabs style): columns by horizontal
//    alignment, rows by baseline, wrapped cell text joined to its row.
// The grid is then read with its headers: columns are announced once, and
// every row is read as "row label: column label, value; column label, value."
// Only text printed in the table is spoken, plus punctuation for pauses.

import { bottom, centerX, right, union } from './geometry';
import { makeLine } from './lines';
import { lineChars, type SpokenChar } from './text';
import type { Line, Rect, Rule } from './types';

interface Cell {
  lines: Line[];
  /** Inclusive grid spans. */
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

interface Grid {
  cells: Cell[];
  rows: number;
  cols: number;
}

/** How to join the next line of a cell: as for paragraphs (hyphen handling). */
export type CellJoin = (seq: SpokenChar[], next: SpokenChar[]) => 'join' | 'keep' | 'space';

export function tableChars(lines: Line[], rules: Rule[], join?: CellJoin): SpokenChar[] {
  return speak(buildGrid(lines, rules), join);
}

export function buildGrid(tableLines: Line[], rules: Rule[]): Grid {
  const lines = tableLines.flatMap(splitCells);
  const box = union(lines.map((l) => l.box));
  const pad = 8;
  const near = rules.filter(
    (r) => r.x1 >= box.x - pad && r.x0 <= right(box) + pad && r.y1 >= box.y - pad && r.y0 <= bottom(box) + pad,
  );
  const vertical = near.filter((r) => r.x1 - r.x0 < 0.5);
  const horizontal = near.filter((r) => r.y1 - r.y0 < 0.5);
  return vertical.length >= 2 && horizontal.length >= 2 ? ruledGrid(lines, vertical, horizontal, box) : alignedGrid(lines, horizontal);
}

/**
 * Lines are split at gaps wider than a word space could be (0.8 em) before
 * we know where tables are; inside a table, cells can sit closer than that.
 */
function splitCells(line: Line): Line[] {
  const parts: Line['fragments'][] = [[]];
  let prev: Line['fragments'][number] | null = null;
  for (const f of line.fragments) {
    if (prev && !f.script && !prev.script && f.x - (prev.x + prev.width) > 0.5 * Math.min(f.fontSize, prev.fontSize)) parts.push([]);
    parts[parts.length - 1].push(f);
    if (!f.script) prev = f;
  }
  return parts.length === 1 ? [line] : parts.filter((p) => p.length).map((p) => ({ ...makeLine(p), role: line.role, block: line.block }));
}

function ruledGrid(lines: Line[], vertical: Rule[], horizontal: Rule[], box: Rect): Grid {
  const tol = 2;
  const edgesOf = (l: Line) => {
    const cx = centerX(l.box);
    const cy = l.box.y + l.box.h / 2;
    const spansY = (v: Rule) => v.y0 - 1 <= cy && cy <= v.y1 + 1;
    const spansX = (h: Rule) => h.x0 - 1 <= cx && cx <= h.x1 + 1;
    const xs = (pick: (v: Rule) => boolean) => vertical.filter((v) => spansY(v) && pick(v)).map((v) => v.x0);
    const ys = (pick: (h: Rule) => boolean) => horizontal.filter((h) => spansX(h) && pick(h)).map((h) => h.y0);
    return {
      left: Math.max(box.x - 1, ...xs((v) => v.x0 <= l.box.x + tol)),
      right: Math.min(right(box) + 1, ...xs((v) => v.x0 >= right(l.box) - tol)),
      top: Math.max(box.y - 1, ...ys((h) => h.y0 <= l.box.y + tol)),
      bottom: Math.min(bottom(box) + 1, ...ys((h) => h.y0 >= bottom(l.box) - tol)),
    };
  };

  // Lines enclosed by the same borders form one cell.
  const groups = new Map<string, { edges: ReturnType<typeof edgesOf>; lines: Line[] }>();
  for (const line of lines) {
    const edges = edgesOf(line);
    const key = [edges.left, edges.right, edges.top, edges.bottom].map((v) => v.toFixed(1)).join();
    if (!groups.has(key)) groups.set(key, { edges, lines: [] });
    groups.get(key)!.lines.push(line);
  }

  // Grid lines: cell edges, with double rules (two lines ~2pt apart) merged.
  const snap = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of sorted) if (!out.length || v - out[out.length - 1] > 3) out.push(v);
    return out;
  };
  const groupList = [...groups.values()];
  const xs = snap(groupList.flatMap((g) => [g.edges.left, g.edges.right]));
  const ys = snap(groupList.flatMap((g) => [g.edges.top, g.edges.bottom]));
  const index = (grid: number[], v: number) =>
    grid.reduce((best, g, i) => (Math.abs(g - v) < Math.abs(grid[best] - v) ? i : best), 0);

  const cells = groupList.map((g) => ({
    lines: g.lines,
    c0: index(xs, g.edges.left),
    c1: Math.max(index(xs, g.edges.left), index(xs, g.edges.right) - 1),
    r0: index(ys, g.edges.top),
    r1: Math.max(index(ys, g.edges.top), index(ys, g.edges.bottom) - 1),
  }));
  return { cells, rows: Math.max(1, ys.length - 1), cols: Math.max(1, xs.length - 1) };
}

function alignedGrid(lines: Line[], horizontal: Rule[] = []): Grid {
  // Columns: separated by vertical bands of white space that (almost) no
  // line crosses; the few lines that do cross one span several columns.
  const x0 = Math.min(...lines.map((l) => l.box.x));
  const x1 = Math.max(...lines.map((l) => right(l.box)));
  const fontSize = lines.reduce((sum, l) => sum + l.fontSize, 0) / lines.length;
  const crossing = Math.max(1, Math.floor(0.08 * lines.length));
  const boundaries: number[] = [];
  let gapStart: number | null = null;
  for (let x = x0; x <= x1 + 1; x += 0.5) {
    const covered = lines.filter((l) => l.box.x < x && right(l.box) > x).length;
    if (covered <= crossing && x < x1) gapStart ??= x;
    else if (gapStart !== null) {
      const b = (gapStart + x) / 2;
      // A real boundary has cells starting after it, not just a ragged edge.
      const starts = lines.some((l) => l.box.x >= x - 1);
      if (x - gapStart >= 0.4 * fontSize && starts) boundaries.push(b);
      gapStart = null;
    }
  }
  const colsOf = (line: Line) => {
    const tol = 0.25 * line.fontSize;
    const c0 = boundaries.filter((b) => b <= line.box.x + tol).length;
    const c1 = boundaries.filter((b) => b < right(line.box) - tol).length;
    return [c0, Math.max(c0, c1)];
  };
  const spanning = new Set(lines.filter((l) => colsOf(l)[1] > colsOf(l)[0]));

  // Rows. Visual rows by baseline; a logical row is anchored by a label in
  // the first column. Labels are either at the top of their row (wrapped
  // text continues below them) or vertically centred on it; both readings
  // are built and the one whose labels sit where they should is kept.
  const visual: Line[][] = [];
  for (const line of [...lines].sort((a, b) => a.baseline - b.baseline)) {
    const row = visual[visual.length - 1];
    if (row && Math.abs(line.baseline - row[0].baseline) <= 0.4 * line.fontSize) row.push(line);
    else visual.push([line]);
  }
  const isAnchor = (l: Line) => colsOf(l)[0] === 0 && !spanning.has(l);

  // A rule with text both above and below it (booktabs' \midrule) ends the
  // header: everything above it is one header row, however many lines.
  const midrule = horizontal
    .map((h) => h.y0)
    .sort((a, b) => a - b)
    .find((y) => lines.some((l) => bottom(l.box) <= y + 1) && lines.some((l) => l.box.y >= y - 1));
  const headerLines = midrule === undefined ? [] : lines.filter((l) => bottom(l.box) <= midrule + 1);
  const bodyVisual = midrule === undefined ? visual : visual.map((row) => row.filter((l) => !headerLines.includes(l))).filter((row) => row.length);
  const rows = [...(headerLines.length ? [headerLines] : []), ...assignRows(bodyVisual, isAnchor, (l) => colsOf(l).join('-'))];

  const cells: Cell[] = [];
  rows.forEach((row, r) => {
    const byCols = new Map<string, Line[]>();
    for (const line of row) {
      const [c0, c1] = colsOf(line);
      const key = `${c0}-${c1}`;
      if (!byCols.has(key)) byCols.set(key, []);
      byCols.get(key)!.push(line);
    }
    for (const [key, cellLines] of byCols) {
      const [c0, c1] = key.split('-').map(Number);
      cells.push({ lines: cellLines, r0: r, r1: r, c0, c1 });
    }
  });
  return { cells, rows: rows.length, cols: boundaries.length + 1 };
}

/**
 * Logical rows. Each row is anchored by its label (first-column text, with
 * wrapped label lines merged). The other columns' lines are grouped into
 * cells by text — a cell starts with a capital, digit or bullet, its wrapped
 * lines continue in lower case — and every cell joins the label nearest its
 * vertical middle. That handles labels at the top of their row and labels
 * centred on it alike.
 */
function assignRows(visual: Line[][], isAnchor: (l: Line) => boolean, columnOf: (l: Line) => string): Line[][] {
  const mid = (ls: Line[]) => (Math.min(...ls.map((l) => l.baseline)) + Math.max(...ls.map((l) => l.baseline))) / 2;
  const text = (l: Line) => l.fragments.map((f) => f.text).join('').trim();

  const anchors: Line[][] = [];
  for (const row of visual) {
    const labels = row.filter(isAnchor);
    if (!labels.length) continue;
    const prev = anchors[anchors.length - 1];
    const last = prev?.[prev.length - 1];
    if (last && labels[0].baseline - last.baseline <= 1.3 * labels[0].fontSize && isWrapped(last)) prev.push(...labels);
    else anchors.push([...labels]);
  }

  if (anchors.length < 2) {
    // No row labels to anchor on: a visual row continues the row above.
    const rows: Line[][] = [];
    for (const row of visual) {
      const prev = rows[rows.length - 1];
      if (prev && !row.some(isAnchor) && row[0].baseline - prev[prev.length - 1].baseline <= 1.6 * row[0].fontSize) prev.push(...row);
      else rows.push([...row]);
    }
    return rows;
  }

  const anchored = new Set(anchors.flat());
  const byColumn = new Map<string, Line[]>();
  for (const line of visual.flat()) {
    if (anchored.has(line)) continue;
    const key = columnOf(line);
    if (!byColumn.has(key)) byColumn.set(key, []);
    byColumn.get(key)!.push(line);
  }
  const rows = anchors.map((a) => [...a]);
  for (const lines of byColumn.values()) {
    lines.sort((a, b) => a.baseline - b.baseline);
    const cells: Line[][] = [];
    for (const line of lines) {
      const cell = cells[cells.length - 1];
      const prev = cell?.[cell.length - 1];
      const continues =
        prev !== undefined &&
        line.baseline - prev.baseline <= 1.6 * line.fontSize &&
        (/[-\u2010]$/.test(text(prev)) || !/^[\p{Lu}\p{N}•·(\[]/u.test(text(line)));
      if (continues) cell.push(line);
      else cells.push([line]);
    }
    for (const cell of cells) {
      let best = 0;
      anchors.forEach((a, i) => {
        if (Math.abs(mid(cell) - mid(a)) < Math.abs(mid(cell) - mid(anchors[best]))) best = i;
      });
      rows[best].push(...cell);
    }
  }
  return rows.map((r) => r.sort((a, b) => a.baseline - b.baseline));
}

/** A label line that continues on the next line ("Vishwakarma et al." / "[12]"). */
const isWrapped = (l: Line) => {
  const text = l.fragments.map((f) => f.text).join('').trim();
  return !/[.:;?!]$/.test(text) || /et al\.$/.test(text);
};

function speak({ cells, rows, cols }: Grid, join?: CellJoin): SpokenChar[] {
  const at = (r: number, c: number) => cells.find((x) => x.r0 <= r && r <= x.r1 && x.c0 <= c && c <= x.c1);

  // Header rows: leading rows with an empty first column (the corner above
  // the row labels). Without such a corner, the first row is the header.
  let headerRows = 0;
  while (headerRows < rows && !at(headerRows, 0)) headerRows++;
  if (headerRows === rows) headerRows = 0;
  let stubCols = 0;
  if (headerRows === 0) {
    headerRows = rows > 1 ? 1 : 0;
    stubCols = cols > 1 ? 1 : 0;
  } else {
    while (stubCols < cols && [...Array(headerRows).keys()].every((r) => !at(r, stubCols))) stubCols++;
  }

  const out: SpokenChar[] = [];
  const say = (text: string) => {
    // Do not double punctuation the cell text already ends with ("analysis..").
    const last = [...out].reverse().find((c) => c.ch !== ' ')?.ch ?? '';
    // A colon after a label ending in "et al." stays.
    if (/^[.;,]/.test(text) && /[.:;,?!]/.test(last)) text = text.slice(1);
    else if (text.startsWith(':') && /[:;,?!]/.test(last)) text = text.slice(1);
    for (const ch of text) out.push({ ch, box: null });
  };
  const sayCell = (cell: Cell) => {
    const lines = [...cell.lines].sort((a, b) => a.baseline - b.baseline || a.box.x - b.box.x);
    const start = out.length;
    lines.forEach((l, i) => {
      const chars = lineChars(l);
      if (i) {
        const decision = join ? join(out.slice(start), chars) : 'space';
        if (decision === 'join') out.pop();
        else if (decision === 'space') say(' ');
      }
      out.push(...chars);
    });
  };
  const cellText = (cell: Cell) => cell.lines.map((l) => lineChars(l).map((c) => c.ch).join('')).join(' ');

  // Column labels: the lowest header cell over each data column; header
  // cells spanning several data columns are group titles, said once.
  const columnLabel = new Map<number, string>();
  const groups: Cell[] = [];
  for (let c = 0; c < cols; c++) {
    for (let r = headerRows - 1; r >= 0; r--) {
      const cell = at(r, c);
      if (cell) {
        columnLabel.set(c, cellText(cell));
        break;
      }
    }
  }
  for (let r = 0; r < headerRows - 1; r++) {
    for (const cell of cells) {
      if (cell.r0 === r && cell.c1 > cell.c0 && cell.c0 >= stubCols && !groups.includes(cell)) groups.push(cell);
    }
  }
  // Announced in order, including the header of the row-label column.
  const labels = [...new Set([...columnLabel.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text))];
  if (labels.length) {
    // The header is read as printed: group titles, then the column names.
    groups.forEach((g, i) => {
      if (i) say(', ');
      sayCell(g);
    });
    if (groups.length) say(': ');
    say(labels.join(', '));
    say('. ');
  }

  for (let r = headerRows; r < rows; r++) {
    const label: Cell[] = [];
    for (let c = 0; c < stubCols; c++) {
      const cell = at(r, c);
      if (!cell || cell.r0 !== r || cell.c0 !== c) continue;
      if (cell.r1 > cell.r0) {
        // A row label spanning several rows names a group of rows.
        sayCell(cell);
        say('. ');
      } else label.push(cell);
    }
    const values: Cell[] = [];
    for (let c = stubCols; c < cols; c++) {
      const cell = at(r, c);
      if (cell && cell.r0 === r && cell.c0 === c && !values.includes(cell)) values.push(cell);
    }
    if (!label.length && !values.length) continue;
    label.forEach((cell, i) => {
      if (i) say(' ');
      sayCell(cell);
    });
    if (label.length && values.length) say(': ');
    values.forEach((cell, i) => {
      if (i) say('; ');
      const name = columnLabel.get(cell.c0);
      if (name) say(`${name}, `);
      sayCell(cell);
    });
    say('. ');
  }
  while (out.length && out[out.length - 1].ch === ' ') out.pop();
  return out;
}
