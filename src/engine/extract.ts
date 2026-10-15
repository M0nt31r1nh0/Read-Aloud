// Adapter from pdf.js text content to engine fragments with per-character
// boxes. Typed structurally so the engine does not depend on a pdf.js build.

import { glyphText } from './glyphs';
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
  /** Loaded fonts (after getOperatorList); glyph names need `fontExtraProperties`. */
  commonObjs?: { has(id: string): boolean; get(id: string): unknown };
}

/** What a pdf.js font object tells about its glyphs. */
interface PdfFontLike {
  composite?: boolean;
  /** Glyph names by character code, from the font's encoding differences. */
  differences?: (string | undefined)[];
  /** Code to text; on the main thread pdf.js sends it as plain data ({ _map }). */
  toUnicode?: { get?(code: number): string | undefined; _map?: (string | undefined)[] };
}

const unicodeOf = (font: PdfFontLike, code: number) =>
  typeof font.toUnicode?.get === 'function' ? font.toUnicode.get(code) : font.toUnicode?._map?.[code];

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

  // The operator list first: it loads the fonts, whose glyph names can
  // correct characters the text layer gets wrong.
  const list = ops && pdfPage.getOperatorList ? await pdfPage.getOperatorList() : null;
  const fonts = new Map<string, Map<string, string> | null>();
  const fixesOf = (name: string) => {
    if (!fonts.has(name)) {
      const objs = pdfPage.commonObjs;
      fonts.set(name, glyphCorrections(objs?.has(name) ? (objs.get(name) as PdfFontLike) : null));
    }
    return fonts.get(name)!;
  };

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

    let ascent = clamp(style.ascent ?? 0.8, 0.5, 1.1);
    let descent = clamp(style.descent ?? -0.2, -0.5, 0);
    // Some fonts report metrics that cover half a line or less (ascent 0.5,
    // no descent): lines would look half as tall, the gaps between them like
    // paragraph breaks, and highlights would cover the top half of the words.
    if (ascent - descent < 0.75) {
      ascent = 0.8;
      descent = -0.2;
    }
    const x = tx[4];
    const baseline = tx[5];
    const str = correctFromGlyphNames(item.str, fixesOf(item.fontName));
    const width = item.width > 0 ? item.width : str.length * fontSize * 0.5;
    const top = baseline - ascent * fontSize;
    const height = (ascent - descent) * fontSize;
    fragments.push({
      page,
      text: str,
      x,
      top,
      width,
      height,
      baseline,
      fontSize,
      fontName: item.fontName,
      chars: charBoxes(x, top, width, height, widths(str, style.fontFamily)),
    });
  }
  const rules = list && ops ? extractRules(list, viewport.transform, ops) : [];
  return { page, width: viewport.width, height: viewport.height, fragments, rules };
}

/**
 * Characters the font's own glyph names contradict: the PDF's character
 * table says "$", "%" or "𝑆", the glyph is named "f_l", "abreve" or
 * "u1D456" (𝑖). Some tables are filled in blindly (LibertineMath assigns
 * 𝐴, 𝐵, 𝐶… to codes in order). Per font, each table entry is compared with
 * its glyph's name:
 *  - a glyph named as a letter (or letters) replaces punctuation or a symbol;
 *  - a letter replaces a different letter only when the font disagrees with
 *    its names that way several times (a broken table, not one odd glyph).
 * Fonts without glyph names are left alone (the dictionary repair in units.ts
 * still applies).
 */
function glyphCorrections(font: PdfFontLike | null): Map<string, string> | null {
  const names = font?.differences;
  if (!names || font.composite || !font.toUnicode) return null;
  const byText = new Map<string, number[]>();
  for (let code = 0; code < 256; code++) {
    const text = unicodeOf(font, code);
    if (text) byText.set(text, [...(byText.get(text) ?? []), code]);
  }
  const punctuation = new Map<string, string>();
  const letters = new Map<string, string>();
  for (const [text, codes] of byText) {
    if (codes.length !== 1) continue; // two glyphs, one character: no way back
    const name = names[codes[0]];
    const real = name ? glyphText(name) : null;
    if (!real || real === text || !/^\p{L}+$/u.test(real)) continue;
    if (/^\p{L}$/u.test(text)) letters.set(text, real);
    else if (!/[\p{N}\s]/u.test(text)) punctuation.set(text, real);
  }
  const fixes = new Map([...punctuation, ...(letters.size >= 3 ? letters : [])]);
  return fixes.size ? fixes : null;
}

function correctFromGlyphNames(str: string, fixes: Map<string, string> | null): string {
  if (!fixes) return str;
  let out = '';
  for (const ch of str) out += fixes.get(ch) ?? ch;
  return out;
}

/**
 * Straight horizontal and vertical lines from the page's drawing operations:
 * stroked segments, and thin filled rectangles (how LaTeX draws \hline).
 * Coordinates are mapped through the graphics state into page space.
 */
function extractRules(list: { fnArray: number[]; argsArray: unknown[] }, viewportTransform: number[], ops: PdfOps): Rule[] {
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
