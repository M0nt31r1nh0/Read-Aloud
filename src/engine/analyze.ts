import { orderLines } from './columns';
import type { Dictionary } from './dictionary';
import type { PageText } from './extract';
import { bottom, centerX, right, union } from './geometry';
import { buildLines } from './lines';
import { findMarginLines } from './margins';
import { CAPTION_START, buildUnits } from './units';
import { lineText } from './text';
import { DEFAULT_OPTIONS, type AnalyzeOptions, type Block, type Line, type PageLayout, type Rect, type ReadingUnit } from './types';

export interface DocumentAnalysis {
  pages: PageLayout[];
  units: ReadingUnit[];
  bodyFontSize: number;
}

/**
 * `dictionary` (optional) resolves line-end hyphens the document itself
 * gives no evidence for, such as "general-" + "purpose".
 */
export function analyzeDocument(
  pages: PageText[],
  options: AnalyzeOptions = DEFAULT_OPTIONS,
  dictionary: Dictionary | null = null,
): DocumentAnalysis {
  const lined = pages.map((p) => ({ ...p, lines: buildLines(p.fragments) }));
  const dropped = findMarginLines(lined);
  const bodyFontSize = dominantFontSize(lined.flatMap((p) => p.lines));

  const layouts: PageLayout[] = lined.map((p) => {
    const kept = p.lines.filter((l) => !dropped.has(l));
    const { ordered, blocks } = orderLines(kept, p.page);
    markFigureText(ordered, blocks, bodyFontSize);
    markFootnotes(ordered, bodyFontSize, p.height);
    const skipped = (l: Line) => l.role === 'figure' || (l.role === 'table' && options.skipTables);
    const read = ordered.filter((l) => !skipped(l));
    return {
      page: p.page,
      width: p.width,
      height: p.height,
      lines: [...read.filter((l) => l.role !== 'footnote'), ...read.filter((l) => l.role === 'footnote')],
      blocks,
      dropped: [...p.lines.filter((l) => dropped.has(l)), ...ordered.filter(skipped)],
      rules: p.rules ?? [],
    };
  });

  return { pages: layouts, units: buildUnits(layouts, bodyFontSize, options, dictionary), bodyFontSize };
}

/** The font size carrying the most characters is the body text size. */
function dominantFontSize(lines: Line[]): number {
  const weight = new Map<number, number>();
  for (const line of lines) {
    const size = Math.round(line.fontSize * 2) / 2;
    const chars = line.fragments.reduce((n, f) => n + f.text.length, 0);
    weight.set(size, (weight.get(size) ?? 0) + chars);
  }
  let best = 10;
  let bestWeight = -1;
  for (const [size, w] of weight) {
    if (w > bestWeight) {
      best = size;
      bestWeight = w;
    }
  }
  return best;
}

/**
 * Footnotes: small text in the lower part of the page with no body-size text
 * below it in the same column.
 */
function markFootnotes(ordered: Line[], bodyFont: number, pageHeight: number) {
  for (const line of ordered) {
    if (line.role || line.fontSize > 0.88 * bodyFont || line.box.y < 0.6 * pageHeight) continue;
    if (CAPTION_START.test(lineText(line))) continue;
    const bodyBelow = ordered.some(
      (other) =>
        other.block === line.block &&
        other.fontSize > 0.88 * bodyFont &&
        other.box.y > bottom(line.box) - 0.1,
    );
    if (!bodyBelow) line.role = 'footnote';
  }
}

/**
 * Text drawn inside figures (diagram labels, axis ticks, legends) and table
 * cells. Starting at a caption, walk away from it through the same column —
 * up for figures, down for tables, the other way if nothing is found there —
 * and mark every line until the first line that looks like body text: body
 * font size, close to a full column wide, and alone on its row (a long table
 * cell still has other cells beside it).
 */
function markFigureText(lines: Line[], blocks: Block[], bodyFont: number) {
  const text = new Map(lines.map((l) => [l, lineText(l)]));
  const bodySize = (l: Line) => Math.abs(l.fontSize - bodyFont) <= 0.1 * bodyFont;
  // Column width from the page layout: the widest text column (or, on a
  // single-column page, the text block). Line widths are misleading on pages
  // with tables: full-width table rows, or many short cells.
  const columns = blocks.filter((b) => b.kind === 'column');
  const columnWidth = Math.max(0, ...(columns.length ? columns : blocks).map((b) => b.box.w));
  // Other cells on the same row within the same column (or full-width area).
  const hasRowmates = (l: Line, area: Rect) =>
    lines.some(
      (o) =>
        o !== l &&
        o.page === l.page &&
        Math.abs(o.baseline - l.baseline) < 0.3 * l.fontSize &&
        centerX(o.box) >= area.x &&
        centerX(o.box) <= right(area),
    );
  // Body text: a full column wide (a two-column page has a neighbour on the
  // same row in the other column), or most of one and alone on its row.
  const bodyLike = (l: Line, area: Rect) =>
    bodySize(l) && (l.box.w >= 0.95 * columnWidth || (l.box.w >= 0.75 * columnWidth && !hasRowmates(l, area)));
  // The short last line of a paragraph next to a figure: starts at the
  // column's left edge, several words, ends a sentence. Labels rarely do.
  const paragraphTail = (l: Line, area: Rect) =>
    bodySize(l) && l.box.x <= area.x + 2 && /[.!?]$/.test(text.get(l)!) && text.get(l)!.split(/\s+/).length >= 4;
  const stops = (l: Line, area: Rect) =>
    l.role !== undefined ||
    bodyLike(l, area) ||
    paragraphTail(l, area) ||
    CAPTION_START.test(text.get(l)!) ||
    (l.fontSize >= 1.15 * bodyFont && /\s/.test(text.get(l)!));

  lines.forEach((caption, captionIndex) => {
    const captionText = text.get(caption)!;
    if (!CAPTION_START.test(captionText)) return;
    const isTable = /^Tab/.test(captionText);
    // The caption's column: its own block plus the column-sized blocks it
    // overlaps horizontally (a column can be subdivided, e.g. a table's label
    // and text columns). Wider blocks such as a page footer are left out; a
    // full-width caption still gets the full width from its own block.
    const own = blocks[caption.block ?? 0]?.box ?? caption.box;
    const overlapping = blocks
      .filter((b) => b.box.x < right(caption.box) && right(b.box) > caption.box.x && b.box.w <= 1.2 * columnWidth)
      .map((b) => b.box);
    const area = union([own, ...overlapping]);

    const walk = (below: boolean): Line[] => {
      const candidates = lines
        .filter(
          (l) =>
            l !== caption &&
            centerX(l.box) >= area.x &&
            centerX(l.box) <= right(area) &&
            (below ? l.box.y >= bottom(caption.box) - 1 : bottom(l.box) <= caption.box.y + 1),
        )
        .sort((a, b) => (below ? a.box.y - b.box.y : b.box.y - a.box.y));
      if (below) {
        // The caption's own continuation lines come first.
        let baseline = caption.baseline;
        while (
          candidates.length &&
          Math.abs(candidates[0].fontSize - caption.fontSize) < 0.5 &&
          candidates[0].baseline - baseline <= 1.5 * caption.fontSize
        ) {
          baseline = candidates[0].baseline;
          candidates.shift();
        }
      }
      const marked: Line[] = [];
      let edge = below ? bottom(caption.box) : caption.box.y;
      for (const l of candidates) {
        if (stops(l, area)) break;
        // Table rows are contiguous: a wide vertical gap ends the table (what
        // follows may be a figure). Figure labels can be spread out, though.
        const gap = below ? l.box.y - edge : edge - bottom(l.box);
        if (isTable && gap > (marked.length ? 2.2 : 3) * l.fontSize) break;
        marked.push(l);
        edge = below ? Math.max(edge, bottom(l.box)) : Math.min(edge, l.box.y);
      }
      return marked;
    };

    let marked = walk(isTable);
    if (marked.length === 0) {
      // Captions on the "wrong" side: accept only content right next to the
      // caption, and for tables only rows that have several cells.
      const other = walk(!isTable);
      const gap = other.length ? Math.min(Math.abs(other[0].box.y - bottom(caption.box)), Math.abs(caption.box.y - bottom(other[0].box))) : Infinity;
      if (gap <= 2.5 * caption.fontSize && (!isTable || other.some((l) => hasRowmates(l, area)))) marked = other;
    }
    for (const l of marked) {
      l.role = isTable ? 'table' : 'figure';
      // All parts of one table are read together, even across blocks.
      l.group = `${caption.page}:${captionIndex}`;
    }
  });
}
