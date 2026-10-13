// Running headers, footers and page numbers sit in the page margins and
// interrupt sentences that continue onto the next page. They are found by
// position plus repetition across pages, not read.

import { bottom } from './geometry';
import { lineText } from './text';
import type { Line } from './types';

const MARGIN = 0.075;
const PAGE_NUMBER = /^(?:page\s+)?(?:[-–—]\s*)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*[-–—])?(?:\s*(?:of|\/)\s*\d{1,4})?$/i;

interface MarginPage {
  page: number;
  height: number;
  lines: Line[];
}

export function findMarginLines(pages: MarginPage[]): Set<Line> {
  const candidates: { line: Line; key: string; page: number; text: string }[] = [];
  for (const p of pages) {
    for (const line of p.lines) {
      const inTop = bottom(line.box) < p.height * MARGIN;
      const inBottom = line.box.y > p.height * (1 - MARGIN);
      if (!inTop && !inBottom) continue;
      const text = lineText(line).trim();
      const key = (inTop ? 'T:' : 'B:') + text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
      candidates.push({ line, key, page: p.page, text });
    }
  }

  const pagesByKey = new Map<string, Set<number>>();
  for (const c of candidates) {
    if (!pagesByKey.has(c.key)) pagesByKey.set(c.key, new Set());
    pagesByKey.get(c.key)!.add(c.page);
  }

  const dropped = new Set<Line>();
  for (const c of candidates) {
    if (PAGE_NUMBER.test(c.text) || pagesByKey.get(c.key)!.size >= 2) dropped.add(c.line);
  }
  return dropped;
}
