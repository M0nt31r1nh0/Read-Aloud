// Running headers, footers and page numbers sit in the page margins and
// interrupt sentences that continue onto the next page. They are found by
// position plus repetition across pages, not read.

import { bottom } from './geometry';
import { lineText } from './text';
import type { Line } from './types';

const MARGIN = 0.075;
const REPEAT_MARGIN = 0.1;
const NUMBER_MARGIN = 0.12;
/** Running headers of the first or last row may sit this far in (LNCS). */
const EDGE_ROW_MARGIN = 0.15;
const PAGE_NUMBER = /^(?:page\s+)?(?:[-–—]\s*)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*[-–—])?(?:\s*(?:of|\/)\s*\d{1,4})?$/i;

interface MarginPage {
  page: number;
  height: number;
  lines: Line[];
}

export function findMarginLines(pages: MarginPage[]): Set<Line> {
  const candidates: { line: Line; key: string; page: number; text: string; outer: boolean; edge: boolean; number: number | null }[] = [];
  for (const p of pages) {
    if (!p.lines.length) continue;
    const firstRow = Math.min(...p.lines.map((l) => l.baseline));
    const lastRow = Math.max(...p.lines.map((l) => l.baseline));
    for (const line of p.lines) {
      // Page numbers must sit in the outer 7.5%; text repeated on several
      // pages (running headers, "Conference'17, …") may reach 10%, or 15% if
      // nothing else on the page is further out.
      const topRow = Math.abs(line.baseline - firstRow) < 2 && bottom(line.box) < p.height * EDGE_ROW_MARGIN;
      const bottomRow = Math.abs(line.baseline - lastRow) < 2 && line.box.y > p.height * (1 - EDGE_ROW_MARGIN);
      const inTop = bottom(line.box) < p.height * REPEAT_MARGIN;
      const inBottom = line.box.y > p.height * (1 - REPEAT_MARGIN);
      const text0 = lineText(line).trim();
      const nearEdge = bottom(line.box) < p.height * NUMBER_MARGIN || line.box.y > p.height * (1 - NUMBER_MARGIN);
      const number = (nearEdge || topRow || bottomRow) && /^\d{1,4}$/.test(text0) ? Number(text0) : null;
      if (!inTop && !inBottom && !topRow && !bottomRow && number === null) continue;
      const outer = bottom(line.box) < p.height * MARGIN || line.box.y > p.height * (1 - MARGIN);
      const edge = !inTop && !inBottom;
      const text = lineText(line).trim();
      const key = (inTop || topRow ? 'T:' : 'B:') + text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
      candidates.push({ line, key, page: p.page, text, outer, edge, number });
    }
  }

  const pagesByKey = new Map<string, Set<number>>();
  for (const c of candidates) {
    if (!pagesByKey.has(c.key)) pagesByKey.set(c.key, new Set());
    pagesByKey.get(c.key)!.add(c.page);
  }

  // Page numbers further in (ACM puts them well above the bottom edge) count
  // when their value follows the page order the same way on several pages.
  const offsets = new Map<number, number>();
  for (const c of candidates) {
    if (c.number !== null) offsets.set(c.number - c.page, (offsets.get(c.number - c.page) ?? 0) + 1);
  }
  const consistent = (c: (typeof candidates)[number]) => c.number !== null && (offsets.get(c.number - c.page) ?? 0) >= 2;

  const dropped = new Set<Line>();
  for (const c of candidates) {
    const pageNumber = PAGE_NUMBER.test(c.text) && (c.outer || consistent(c));
    // Further in, a header must repeat on more pages: one shared first line
    // (a section title) is not enough.
    if (pageNumber || pagesByKey.get(c.key)!.size >= (c.edge ? 3 : 2)) dropped.add(c.line);
  }
  return dropped;
}
