import { orderLines } from './columns';
import type { Dictionary } from './dictionary';
import type { PageText } from './extract';
import { bottom, centerX, right, union } from './geometry';
import { dropHiddenText } from './hidden';
import { buildLines } from './lines';
import { findMarginLines } from './margins';
import { CAPTION_START, buildUnits, isCaptionLine } from './units';
import { lineText } from './text';
import { DEFAULT_OPTIONS, type AnalyzeOptions, type Block, type Line, type PageLayout, type Rect, type ReadingUnit, type Rule } from './types';

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
  const lined = pages.map((p) => ({ ...p, lines: buildLines(dropHiddenText(p.fragments)) }));
  const dropped = findMarginLines(lined);
  const bodyFontSize = dominantFontSize(lined.flatMap((p) => p.lines));

  const layouts: PageLayout[] = lined.map((p) => {
    const kept = p.lines.filter((l) => !dropped.has(l));
    const { ordered, blocks } = orderLines(kept, p.page, bodyFontSize);
    markInTextMentions(ordered);
    markFigureText(ordered, blocks, bodyFontSize);
    markFootnotes(ordered, bodyFontSize, p.height, blocks, p.rules ?? []);
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
 * "… as evidenced in Appendix" / "Table 5. Therefore, …": a line that starts
 * like a caption but continues the sentence of the line above it.
 */
function markInTextMentions(ordered: Line[]) {
  ordered.forEach((line, i) => {
    const prev = ordered[i - 1];
    if (!prev || !CAPTION_START.test(lineText(line))) return;
    const prevText = lineText(prev).trim();
    line.inText =
      prev.block === line.block &&
      Math.abs(prev.fontSize - line.fontSize) < 0.5 &&
      line.baseline > prev.baseline &&
      line.baseline - prev.baseline <= 1.6 * line.fontSize &&
      line.box.x <= prev.box.x + 0.5 * line.fontSize &&
      isProse(prevText) &&
      !/[.!?:]["'”’)\]]?$/.test(prevText);
  });
}

/**
 * Footnotes, two ways:
 *  - under the footnote rule: the short line LaTeX (and most templates) draws
 *    at a column's left edge above the footnotes. Everything below it in that
 *    column is footnotes, whatever its size (URLs are often set larger);
 *  - otherwise, small text in the lower part of the page with no body-size
 *    text below it in the same column.
 */
function markFootnotes(ordered: Line[], bodyFont: number, pageHeight: number, blocks: Block[], rules: Rule[]) {
  for (const rule of rules) {
    const width = rule.x1 - rule.x0;
    if (rule.y1 - rule.y0 > 1 || rule.y0 < 0.5 * pageHeight || width < 20) continue;
    const column = blocks.find((b) => Math.abs(b.box.x - rule.x0) <= 4 && width <= 0.6 * b.box.w && rule.y0 >= b.box.y);
    if (!column) continue;
    const inColumn = (l: Line) => centerX(l.box) >= column.box.x && centerX(l.box) <= right(column.box);
    const below = ordered.filter((l) => !l.role && l.box.y >= rule.y0 - 1 && inColumn(l)).sort((a, b) => a.box.y - b.box.y);
    // The footnote rule has white space above it; a fraction bar at the
    // start of a line sits right under its numerator.
    const above = ordered.filter((l) => bottom(l.box) <= rule.y0 + 1 && inColumn(l));
    if (above.some((l) => rule.y0 - bottom(l.box) < 0.4 * bodyFont)) continue;
    // The first footnote starts with its mark ("1", "*", "†"), raised or not,
    // or is set smaller; a short table rule above body text does not.
    const first = below[0];
    if (!first || first.box.y - rule.y0 > 2 * bodyFont) continue;
    const marked = first.fragments[0]?.script === 'super' || /^[\d*∗†‡§¶]/.test(lineText(first).trim()) || first.fontSize <= 0.88 * bodyFont;
    if (!marked || below.some((l) => l.fontSize > 1.05 * bodyFont)) continue;
    for (const line of below) line.role = 'footnote';
  }
  for (const line of ordered) {
    if (line.role || line.fontSize > 0.88 * bodyFont || line.box.y < 0.6 * pageHeight) continue;
    if (isCaptionLine(line, lineText(line))) continue;
    const bodyBelow = ordered.some(
      (other) =>
        other.block === line.block &&
        other.fontSize > 0.88 * bodyFont &&
        other.box.y > bottom(line.box) - 0.1,
    );
    if (!bodyBelow) line.role = 'footnote';
  }
}

const STOP_WORDS = new Set(
  'the of and to a in is for with that on as we by are this it be from an or which our can at not its their these has have was were'.split(' '),
);

/** Prose: at least four words, mostly letters, and at least one common small word. */
export function isProse(text: string): boolean {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const letters = text.replace(/[^\p{L}]/gu, '').length;
  return words.length >= 4 && letters >= 0.5 * text.replace(/\s/g, '').length && words.some((w) => STOP_WORDS.has(w));
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
  // Column width: the width of the block holding the most prose lines (the
  // text column). Line widths are misleading on pages with tables (full-width
  // rows, many short cells), and so is the widest block (a table split into
  // sub-columns can be wider than the text columns).
  const proseCount = new Map<number, number>();
  for (const l of lines) if (bodySize(l) && isProse(text.get(l)!)) proseCount.set(l.block ?? 0, (proseCount.get(l.block ?? 0) ?? 0) + 1);
  const textBlock = [...proseCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const columnWidth = textBlock !== undefined ? blocks[textBlock].box.w : Math.max(0, ...blocks.map((b) => b.box.w));
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
  // Body text is prose: several words including common small ones. Table
  // rows (numbers) and diagram label rows ("Vision Encoder Projector LLM")
  // can be just as wide but are not.
  const prose = (l: Line) => isProse(text.get(l)!);
  const bodyLike = (l: Line, area: Rect) =>
    bodySize(l) && prose(l) && (l.box.w >= 0.95 * columnWidth || (l.box.w >= 0.75 * columnWidth && !hasRowmates(l, area)));
  // The short last line of a paragraph next to a figure: starts at the
  // column's left edge, several words, ends a sentence. Labels rarely do.
  const paragraphTail = (l: Line, area: Rect) =>
    bodySize(l) && l.box.x <= area.x + 2 && /[.!?]$/.test(text.get(l)!) && prose(l);
  // A bold run-in heading ("Cost Savings. Subsequently, we examine…") splits a
  // body line in two: a short phrase ending in "." and prose after it.
  const runInRow = (l: Line) => {
    const row = lines
      .filter((o) => o.page === l.page && Math.abs(o.baseline - l.baseline) < 0.3 * l.fontSize)
      .sort((a, b) => a.box.x - b.box.x);
    for (let k = 0; k + 1 < row.length; k++) {
      const [head, rest] = [row[k], row[k + 1]];
      const headText = text.get(head)!;
      const close = rest.box.x - right(head.box) <= 2 * l.fontSize;
      const short = /^\p{Lu}/u.test(headText) && /\.$/.test(headText) && headText.split(/\s+/).length <= 6;
      if (close && short && isProse(text.get(rest)!) && right(rest.box) - head.box.x >= 0.9 * columnWidth) return true;
    }
    return false;
  };
  // Captions with their wrapped lines: another figure's caption ends a walk.
  const captionLines = new Set<Line>();
  for (const caption of lines) {
    if (!isCaptionLine(caption, text.get(caption)!)) continue;
    let last = caption;
    for (;;) {
      const next = lines.find(
        (o) =>
          o.page === last.page &&
          o.block === last.block &&
          Math.abs(o.fontSize - caption.fontSize) < 0.5 &&
          o.baseline > last.baseline + 0.5 * o.fontSize &&
          o.baseline - last.baseline <= 1.5 * caption.fontSize,
      );
      if (!next || captionLines.has(next)) break;
      captionLines.add(next);
      last = next;
    }
  }
  const stops = (l: Line, area: Rect) =>
    l.role !== undefined ||
    captionLines.has(l) ||
    bodyLike(l, area) ||
    paragraphTail(l, area) ||
    (bodySize(l) && runInRow(l)) ||
    isCaptionLine(l, text.get(l)!) ||
    (l.fontSize >= 1.15 * bodyFont && /\s/.test(text.get(l)!));

  lines.forEach((caption, captionIndex) => {
    const captionText = text.get(caption)!;
    if (!isCaptionLine(caption, captionText)) return;
    const isTable = /^tab/i.test(captionText);
    // The caption's column: its own block plus the column-sized blocks it
    // overlaps horizontally (a column can be subdivided, e.g. a table's label
    // and text columns). Wider blocks such as a page footer are left out; a
    // full-width caption still gets the full width from its own block.
    // A caption in a column (or beside a wrap figure) only searches column
    // blocks; full-width text above and below is not part of its figure.
    const ownBlock = blocks[caption.block ?? 0];
    const own = ownBlock?.box ?? caption.box;
    const overlapping = blocks.filter(
      (b) =>
        b.box.x < right(caption.box) &&
        right(b.box) > caption.box.x &&
        (ownBlock?.kind === 'column' ? b.kind === 'column' : b.box.w <= 1.2 * columnWidth),
    );
    const area = union([own, ...overlapping.map((b) => b.box)]);
    // Only lines of those blocks: a wide figure block can make the area reach
    // into the next column.
    const searched = new Set([caption.block ?? 0, ...overlapping.map((b) => b.order)]);

    const walk = (below: boolean): Line[] => {
      const candidates = lines
        .filter(
          (l) =>
            l !== caption &&
            searched.has(l.block ?? 0) &&
            centerX(l.box) >= area.x &&
            centerX(l.box) <= right(area) &&
            // By baseline: line boxes can be taller than the line spacing, so a
            // caption's next line can start above where its first one ends.
            (below ? l.baseline > caption.baseline + 0.5 * caption.fontSize : l.baseline < caption.baseline - 0.5 * caption.fontSize),
        )
        .sort((a, b) => (below ? a.box.y - b.box.y : b.box.y - a.box.y));
      let edge = below ? bottom(caption.box) : caption.box.y;
      if (below) {
        // The caption's own continuation lines come first; the gap to the
        // table is measured from the last of them.
        let baseline = caption.baseline;
        while (
          candidates.length &&
          Math.abs(candidates[0].fontSize - caption.fontSize) < 0.5 &&
          candidates[0].baseline - baseline <= 1.5 * caption.fontSize
        ) {
          baseline = candidates[0].baseline;
          edge = Math.max(edge, bottom(candidates[0].box));
          candidates.shift();
        }
      }
      const marked: Line[] = [];
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

    const gapTo = (side: Line[]) =>
      side.length ? Math.min(Math.abs(side[0].box.y - bottom(caption.box)), Math.abs(caption.box.y - bottom(side[0].box))) : Infinity;
    // Captions on the "wrong" side: accept only content right next to the
    // caption, and for tables only rows that have several cells.
    const fitsOther = (other: Line[]) =>
      gapTo(other) <= 2.5 * caption.fontSize && (!isTable || other.some((l) => hasRowmates(l, area)));
    let marked = walk(isTable);
    const other = walk(!isTable);
    if (marked.length === 0) {
      if (fitsOther(other)) marked = other;
    } else if (isTable && fitsOther(other) && gapTo(other) < gapTo(marked)) {
      // A table right above its caption (ACL style puts every table caption
      // below), with the next table further down the page.
      marked = other;
    }
    for (const l of marked) {
      l.role = isTable ? 'table' : 'figure';
      // All parts of one table are read together, even across blocks.
      l.group = `${caption.page}:${captionIndex}`;
    }
  });
}
