// Adapter from pdf.js text content to engine fragments with per-character
// boxes. Typed structurally so the engine does not depend on a pdf.js build.

import { approximateWidths, type CharWidths } from './measure';
import type { Fragment, Rect, Rule } from './types';

export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL?: boolean;
}

export interface PdfTextStyle {
  fontFamily: string;
  ascent?: number;
  descent?: number;
  vertical?: boolean;
}

export interface PdfPageLike {
  getViewport(params: { scale: number }): { width: number; height: number; transform: number[] };
  getTextContent(): Promise<{ items: unknown[]; styles: Record<string, PdfTextStyle> }>;
  getOperatorList?(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
}

/** The pdf.js `OPS` codes needed to read ruling lines (pass `pdfjs.OPS`). */
export interface PdfOps {
  save: number;
  restore: number;
  transform: number;
  constructPath: number;
  stroke: number;
  closeStroke: number;
  fill: number;
  eoFill: number;
  fillStroke: number;
  eoFillStroke: number;
  closeFillStroke: number;
  closeEOFillStroke: number;
}

export interface PageText {
  page: number;
  width: number;
  height: number;
  fragments: Fragment[];
  /** Ruling lines; empty unless `ops` was passed to extractPage. */
  rules: Rule[];
}

export async function extractPage(
  pdfPage: PdfPageLike,
  page: number,
  widths: CharWidths = approximateWidths,
  ops?: PdfOps,
): Promise<PageText> {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const content = await pdfPage.getTextContent();
  const fragments: Fragment[] = [];

  for (const item of content.items) {
    if (!isTextItem(item) || item.str.trim() === '') continue;
    const style = content.styles[item.fontName] ?? { fontFamily: 'sans-serif' };
    const tx = multiply(viewport.transform, item.transform);
    const fontSize = Math.hypot(tx[2], tx[3]);
    // Only horizontal, left-to-right text is read. This also skips rotated
    // margin stamps such as arXiv's vertical identifier.
    const horizontal =
      tx[0] > 0 && Math.abs(tx[1]) < fontSize * 0.01 && Math.abs(tx[2]) < fontSize * 0.01;
    if (!(fontSize > 0) || !horizontal || style.vertical) continue;

    const ascent = clamp(style.ascent ?? 0.8, 0.5, 1.1);
    const descent = clamp(style.descent ?? -0.2, -0.5, 0);
    const x = tx[4];
    const baseline = tx[5];
    const width = item.width > 0 ? item.width : item.str.length * fontSize * 0.5;
    const top = baseline - ascent * fontSize;
    const height = (ascent - descent) * fontSize;
    fragments.push({
      page,
      text: item.str,
      x,
      top,
      width,
      height,
      baseline,
      fontSize,
      fontName: item.fontName,
      chars: charBoxes(x, top, width, height, widths(item.str, style.fontFamily)),
    });
  }
  const rules = ops && pdfPage.getOperatorList ? await extractRules(pdfPage, viewport.transform, ops) : [];
  return { page, width: viewport.width, height: viewport.height, fragments, rules };
}

/**
 * Straight horizontal and vertical lines from the page's drawing operations:
 * stroked segments, and thin filled rectangles (how LaTeX draws \hline).
 * Coordinates are mapped through the graphics state into page space.
 */
async function extractRules(pdfPage: PdfPageLike, viewportTransform: number[], ops: PdfOps): Promise<Rule[]> {
  const list = await pdfPage.getOperatorList!();
  const strokes = new Set([ops.stroke, ops.closeStroke, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  const fills = new Set([ops.fill, ops.eoFill]);
  const rules: Rule[] = [];
  const stack: number[][] = [];
  let ctm = viewportTransform;

  list.fnArray.forEach((fn, i) => {
    const args = list.argsArray[i] as unknown[];
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() ?? viewportTransform;
    else if (fn === ops.transform) ctm = multiply(ctm, args as number[]);
    else if (fn === ops.constructPath) {
      // pdf.js >= 5: [paintOp, [pathData], minMax]; path ops 0 moveTo, 1 lineTo,
      // 2 curveTo, 3 quadraticCurveTo, 4 closePath.
      const [paint, paths] = args as [number, ArrayLike<number>[] | null];
      const data = paths?.[0];
      if (!data || !(strokes.has(paint) || fills.has(paint))) return;
      const points: [number, number][][] = [];
      let current: [number, number][] = [];
      for (let k = 0; k < data.length; ) {
        const op = data[k];
        if (op === 0 || op === 1) {
          const p = apply(ctm, data[k + 1], data[k + 2]);
          if (op === 0 && current.length) {
            points.push(current);
            current = [];
          }
          current.push(p);
          k += 3;
        } else if (op === 2) {
          current = [];
          k += 7;
        } else if (op === 3) {
          current = [];
          k += 5;
        } else {
          if (current.length) current.push(current[0]);
          k += 1;
        }
      }
      if (current.length) points.push(current);

      for (const poly of points) {
        if (strokes.has(paint)) {
          for (let k = 1; k < poly.length; k++) addRule(rules, poly[k - 1], poly[k]);
        } else {
          const xs = poly.map((p) => p[0]);
          const ys = poly.map((p) => p[1]);
          const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
          if (y1 - y0 <= 2 && x1 - x0 >= 4) addRule(rules, [x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2]);
          else if (x1 - x0 <= 2 && y1 - y0 >= 4) addRule(rules, [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1]);
        }
      }
    }
  });
  return rules;
}

function addRule(rules: Rule[], a: [number, number], b: [number, number]) {
  const horizontal = Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[0] - b[0]) >= 4;
  const vertical = Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) >= 4;
  if (!horizontal && !vertical) return;
  rules.push({ x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) });
}

function apply(m: number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function charBoxes(x: number, top: number, width: number, height: number, relative: number[]): Rect[] {
  const total = relative.reduce((sum, w) => sum + w, 0) || 1;
  let cursor = x;
  return relative.map((r) => {
    const w = (r / total) * width;
    const box = { x: cursor, y: top, w, h: height };
    cursor += w;
    return box;
  });
}

function isTextItem(item: unknown): item is PdfTextItem {
  return typeof item === 'object' && item !== null && 'str' in item && 'transform' in item;
}

/** Same composition as pdf.js `Util.transform`. */
function multiply(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
