// Ordered lines -> reading units (paragraphs, headings, captions, footnotes,
// equations). Paragraphs may continue across columns and pages. Captions and
// footnotes are held back until the paragraph they interrupted has finished.
// Display maths is read as a short placeholder ("equation 3") inside the
// sentence that introduces it.

import type { Dictionary } from './dictionary';
import { median, right } from './geometry';
import { Lexicon, lineJoin, repairLigatures } from './hyphenation';
import { splitSentences } from './sentences';
import { tableChars } from './tables';
import { collapseSpaces, lineChars, lineText, normalizeChars, replaceAll, type SpokenChar } from './text';
import type { AnalyzeOptions, CharBox, Line, PageLayout, ReadingUnit, Rect, Rule, UnitKind } from './types';

// "Figure 3:", "Fig. 3.", "Table 2:", IEEE "TABLE IV" / "FIG. 2." (also alone on
// their line). "Table 1 shows …" in body text does not match.
/** A caption's first line; not a sentence that wraps onto "Table 5. …". */
export const isCaptionLine = (line: Line, text: string) => !line.inText && CAPTION_START.test(text);

export const CAPTION_START = /^(?:Figure|Fig\.|Table|FIGURE|FIG\.|TABLE)\s*(?:\d+|[IVXLC]+)(?:[.:]|\s*$)/;
// Section numbers: "3", "3.2", "3.2.1", "IV." — not "0.30." or "12 GPUs" (those
// are rejected by context in isHeading). Letter numbering ("A. Proofs") is
// left out: it collides with author initials.
const NUMBERED_HEADING_PREFIX = /^\S+\s+/;
const NUMBERED_HEADING = /^(?:[1-9]\d?(?:\.\d{1,2}){0,3}\.?|[IVX]+\.|[A-H](?:\.\d{1,2}){1,3}\.?|[A-H])\s+\p{Lu}/u;
const ENDS_SENTENCE = /[.!?:]["'”’)\]]?$/;
// A bracket group, optionally a range of two groups ("[3]–[5]").
export const CITATION_PATTERN = /\s*\[([^[\]]{1,120})\](?:\s*[–-]\s*\[([^[\]]{1,120})\])?/g;
const CITATION_ITEM = /^(?:[1-9]\d{0,3}(?:\s*[–-]\s*[1-9]\d{0,3})?|[A-Z][A-Za-z+]{1,7}\d{2,4}[a-z]?)$/;
const REFERENCE_LABEL = /^\[\d+\](?:\s|$)/;
const BIBLIOGRAPHY = /^(?:\d+\.?\s*)?(?:references|bibliography|works cited|literature cited)$/i;
// Some publishers' fonts map the "Th" ligature to "+" ("+e", "+is", "+us").
// Only the words that ligature produces are repaired, so maths ("+w") is not.
const BROKEN_TH = new RegExp(
  `(?<=^|[\\s“"‘'(\\[])\\+(?=(?:${[
    'e', 'is', 'us', 'at', 'ey', 'en', 'ere', 'erefore', 'ereby', 'ese', 'ose', 'eir', 'em', 'an', 'ird', 'ree',
    'rough', 'roughout', 'ough', 'ought', 'ousand', 'ousands', 'eory', 'eoretical', 'eoretically', 'eorem', 'reshold', 'us,',
  ].join('|')})\\b)`,
  'g',
);
// Broken ligatures ("e!ectively", "re$ective"): see repairLigatures.
const BROKEN_LIGATURE = /[\p{L}!"#$%]*\p{L}[\p{L}!"#$%]*/gu;

const URL = /\b(?:https?:\/\/|www\.)[^\s]+/g;
const URL_TOKEN = /(?:^|\s)(?:https?:\/\/|www\.)\S*$/;

const ABBREVIATIONS: [RegExp, string | ((m: string) => string)][] = [
  [URL, speakUrl],
  [/\bFigs?\.(?=\s*\d)/g, (m) => (m.startsWith('Figs') ? 'Figures' : 'Figure')],
  [/\bEqs?\.(?=\s*\(?\d)/g, (m) => (m.startsWith('Eqs') ? 'Equations' : 'Equation')],
  [/\bSecs?\.(?=\s*\d)/g, (m) => (m.startsWith('Secs') ? 'Sections' : 'Section')],
  [/§§\s?/g, 'Sections '],
  [/§\s?/g, 'Section '],
  [/\bTab\.(?=\s*\d)/g, 'Table'],
  [/\bRef\.(?=\s*\[?\d)/g, 'Reference'],
  [/\be\.g\.,?/g, (m) => (m.endsWith(',') ? 'for example,' : 'for example')],
  [/\bi\.e\.,?/g, (m) => (m.endsWith(',') ? 'that is,' : 'that is')],
  [/\bw\.r\.t\./g, 'with respect to'],
  [/\bvs\./g, 'versus'],
  [/\bcf\./g, 'compare'],
  [/(?<=\d)\s*[*×]\s*(?=\d)/g, ' times '],
  [/~\s?(?=\d)/g, 'about '],
  [/(?<=\p{L})_(?=\p{L})/gu, ' '],
  [/[✗✘]/g, 'cross'],
  [/[✓✔]/g, 'check'],
];

// List bullets are layout, not words: voices read "•" as "bullet" or "dot".
// After a sentence (or at the start) the bullet goes; between items that do
// not end a sentence it becomes a pause.
const BULLET = '[•◦▪▫‣⁃●○■□▸►]';
const LIST_MARKERS: [RegExp, string][] = [
  [new RegExp(`(?<=^|[.!?:;]["'”’)\\]]?)\\s*${BULLET}(?=\\s)`, 'gu'), ' '],
  [new RegExp(`\\s+${BULLET}(?=\\s)`, 'gu'), ';'],
];

// Display maths: a maths symbol and (almost) no ordinary words.
const MATH_SYMBOL = /[=∑∏∫∈∉∀∃≤≥≠≈×÷√∞∂±→⇒∧∨⊆⊂∪∩]/u;
const MATH_WORDS = new Set(['sin', 'cos', 'tan', 'log', 'exp', 'max', 'min', 'sigmoid', 'argmin', 'argmax', 'lim', 'sum', 'mod']);
const EQUATION_NUMBER = /\((\d{1,3}[a-z]?)\)\s*$/;

type Item = { line: Line } | { math: Line[] } | { table: Line[] };

interface Open {
  items: Item[];
  kind: UnitKind;
}

interface Placed {
  line: Line;
  text: string;
  block: Rect;
}

export function buildUnits(
  pages: PageLayout[],
  bodyFont: number,
  options: AnalyzeOptions,
  dictionary: Dictionary | null = null,
): ReadingUnit[] {
  const stream: Placed[] = pages.flatMap((p) => {
    // A block's margins are where its wide (text) lines start and end:
    // figure labels in the same block can reach further out, and would make
    // every text line look indented, or short like a paragraph's last line.
    const blocks = p.blocks.map((b) => {
      const wide = p.lines.filter((l) => l.block === b.order && l.box.w >= 0.5 * b.box.w);
      if (!wide.length) return b.box;
      // Reference labels ("[LLL 21]") set apart left of their entries are
      // part of the text margin.
      const labels = p.lines.filter((l) => l.block === b.order && /^\[[^\]\s][^\]]{0,15}\]/.test(lineText(l)));
      const x = Math.min(...wide.map((l) => l.box.x), ...labels.map((l) => l.box.x));
      return { ...b.box, x, w: Math.max(...wide.map((l) => right(l.box))) - x };
    });
    return p.lines.map((line) => ({ line, text: lineText(line), block: blocks[line.block ?? 0] }));
  });
  const lexicon = new Lexicon(dictionary);
  for (const s of stream) lexicon.addLine(s.text);
  const pitch = linePitch(stream, bodyFont);
  const math = mathLines(stream, bodyFont, pitch);
  const bodyFontName = dominantFontName(stream, bodyFont);

  const rulesOf = new Map(pages.map((p) => [p.page, p.rules]));
  const units: ReadingUnit[] = [];
  const emit = (items: Item[], kind: UnitKind) => {
    if (kind === 'caption' && options.skipCaptions) return;
    const unit = makeUnit(units.length, items, kind, lexicon, options, (page) => rulesOf.get(page) ?? []);
    // A fragment without a single letter ("2", "(1)", "0.60", "!") is a stray
    // mark, tick label or equation number; read alone it means nothing.
    if (unit.text && /\p{L}/u.test(unit.text)) units.push(unit);
  };

  let current: Open | null = null;
  let prev: Placed | null = null;
  let aside: Open | null = null;
  let asidePrev: Placed | null = null;
  let interrupted = false;
  let afterMath = false;
  let inBibliography = false;
  let mathGroup: Line[] = [];
  let tableGroup: Line[] = [];
  const readTables = new Set<string>();
  const deferred: Open[] = [];
  const footnotes: Line[] = [];

  const close = () => {
    if (current) emit(current.items, current.kind);
    current = null;
    afterMath = false;
    for (const a of deferred.splice(0)) emit(a.items, a.kind);
    if (!options.skipFootnotes) for (const group of groupFootnotes(footnotes)) emit(group.map((line) => ({ line })), 'footnote');
    footnotes.length = 0;
  };
  const endAside = () => {
    if (!aside) return;
    if (current) deferred.push(aside);
    else emit(aside.items, aside.kind);
    aside = null;
  };
  // Table cells are read after the caption, once the paragraph is finished.
  const flushTable = () => {
    if (!tableGroup.length) return;
    const table: Open = { items: [{ table: tableGroup }], kind: 'table' };
    tableGroup = [];
    if (current) deferred.push(table);
    else emit(table.items, table.kind);
  };
  const flushMath = () => {
    if (!mathGroup.length) return;
    const item = { math: mathGroup };
    mathGroup = [];
    // Inline only when the sentence runs into the formula ("as follows:").
    if (current?.kind === 'paragraph' && prev && !/[.!?]["'”’)\]]?$/.test(prev.text)) {
      current.items.push(item);
      afterMath = true;
    } else {
      close();
      emit([item], 'equation');
    }
  };

  stream.forEach((s, i) => {
    if (s.line.role === 'footnote') {
      footnotes.push(s.line);
      return;
    }
    if (s.line.role === 'table') {
      // A table is read once, whole, when its first line comes up.
      if (s.line.group !== undefined && readTables.has(s.line.group)) return;
      endAside();
      if (tableGroup.length && tableGroup[0].group !== s.line.group) flushTable();
      if (s.line.group !== undefined) {
        readTables.add(s.line.group);
        tableGroup.push(...stream.filter((t) => t.line.role === 'table' && t.line.group === s.line.group).map((t) => t.line));
      } else tableGroup.push(s.line);
      return;
    }
    flushTable();
    if (math[i]) {
      endAside();
      mathGroup.push(s.line);
      return;
    }
    flushMath();

    // The rest of a row split at a wide space ("C   Prompts used", a run-in
    // heading and its paragraph) goes with the start of the row.
    if (current && prev && !aside && sameRow(prev.line, s.line)) {
      current.items.push({ line: s.line });
      prev = s;
      return;
    }
    const heading = isHeading(stream, i, bodyFont, pitch, bodyFontName);
    const caption = isCaptionLine(s.line, s.text);
    if (heading) inBibliography = BIBLIOGRAPHY.test(s.text.trim());

    if (aside && asidePrev) {
      const continuesAside =
        !caption && !heading && sameBlock(asidePrev.line, s.line) && !startsParagraph(asidePrev, s, pitch, false);
      if (continuesAside) {
        aside.items.push({ line: s.line });
        asidePrev = s;
        return;
      }
      endAside();
    }
    if (caption) {
      aside = { items: [{ line: s.line }], kind: 'caption' };
      asidePrev = s;
      if (current) interrupted = true;
      return;
    }

    if (current && prev) {
      // A heading wrapped onto a second line: in heading size, or in the
      // heading's own (bold) font when headings are body-sized.
      const headingFont = s.line.fontName === prev.line.fontName && s.line.fontName !== bodyFontName;
      const continuesHeading =
        current.kind === 'heading' &&
        (heading || headingFont) &&
        sameBlock(prev.line, s.line) &&
        s.line.baseline - prev.line.baseline < 1.3 * s.line.fontSize;
      let breaks: boolean;
      if (continuesHeading) breaks = false;
      else if (current.kind === 'heading' || heading) breaks = true;
      // After display maths the sentence goes on only if the text does ("where …").
      else if (afterMath) breaks = !/^[\p{Ll},;]/u.test(s.text);
      else if (inBibliography) breaks = startsEntry(prev, s, pitch);
      else {
        const first = current.items[0];
        const inReference = 'line' in first && REFERENCE_LABEL.test(lineText(first.line));
        breaks = startsParagraph(prev, s, pitch, interrupted, stream[i + 1], inReference);
      }
      if (breaks) close();
    }
    current ??= { items: [], kind: heading ? 'heading' : 'paragraph' };
    current.items.push({ line: s.line });
    prev = s;
    interrupted = false;
    afterMath = false;
  });
  flushTable();
  flushMath();
  endAside();
  close();

  // A caption set below its own table is read before the table's cells.
  const top = (u: ReadingUnit) => Math.min(...u.boxes.filter((b): b is CharBox => !!b).map((b) => b.y));
  const bottomOf = (u: ReadingUnit) => Math.max(...u.boxes.filter((b): b is CharBox => !!b).map((b) => b.y + b.h));
  const pageOf = (u: ReadingUnit) => u.boxes.find((b) => b)?.page;
  for (let k = 0; k + 1 < units.length; k++) {
    const [table, caption] = [units[k], units[k + 1]];
    const below = pageOf(table) === pageOf(caption) && top(caption) >= bottomOf(table) - 1;
    if (table.kind === 'table' && caption.kind === 'caption' && /^Tab/.test(caption.text) && below) {
      [units[k], units[k + 1]] = [units[k + 1], units[k]];
      k++;
    }
  }
  units.forEach((u, id) => (u.id = id));
  return units;
}

/**
 * `interrupted`: a caption or figure sat between the two lines. `next` is the
 * line after `cur`, used to tell a first-line indent (next line back at the
 * margin) from a hanging indent (reference lists, wrapped list items).
 */
function startsParagraph(
  prev: Placed,
  cur: Placed,
  pitch: number,
  interrupted: boolean,
  next?: Placed,
  inReference = false,
): boolean {
  const p = prev.line;
  const c = cur.line;
  // A row split at a wide justified space, or around a subscript, goes on.
  if (sameRow(p, c)) return false;
  if (Math.abs(c.fontSize - p.fontSize) > 0.15 * p.fontSize) return true;
  if (REFERENCE_LABEL.test(cur.text) && (inReference || ENDS_SENTENCE.test(prev.text))) return true;
  // Inside a reference entry, wrapped lines (hanging indent, URLs) belong to
  // it, also across column and page breaks. Text after the reference list
  // starts with a heading ("Appendix"), which ends the entry.
  if (inReference) return sameBlock(p, c) && c.baseline - p.baseline > 1.5 * pitch;

  const same = sameBlock(p, c) && !interrupted;
  if (same && c.baseline - p.baseline > 1.5 * pitch) return true;
  if (!same && /\p{L}[-‐­]$/u.test(prev.text)) return false; // word split across columns/pages

  const endsSentence = ENDS_SENTENCE.test(prev.text);
  const hanging =
    next !== undefined &&
    sameBlock(c, next.line) &&
    next.line.baseline - c.baseline > 0 &&
    next.line.baseline - c.baseline <= 1.3 * pitch &&
    next.line.box.x > cur.block.x + 0.8 * c.fontSize;
  const indented = c.box.x > cur.block.x + 0.8 * c.fontSize && !hanging;
  const prevShort = right(p.box) < right(prev.block) - 2 * c.fontSize;
  return endsSentence && (indented || prevShort);
}

/**
 * In a reference list, entries start at the margin and their wrapped lines
 * are indented (hanging indent) — in author-year styles ("Brown, T. 2020.")
 * as well as numbered ones. Without hanging indents, an entry ends at a line
 * that ends a sentence.
 */
function startsEntry(prev: Placed, cur: Placed, pitch: number): boolean {
  if (REFERENCE_LABEL.test(cur.text)) return true;
  const same = sameBlock(prev.line, cur.line);
  if (same && cur.line.baseline - prev.line.baseline > 1.5 * pitch) return true;
  const atMargin = cur.line.box.x <= cur.block.x + 0.5 * cur.line.fontSize;
  return atMargin && ENDS_SENTENCE.test(prev.text);
}

function isHeading(stream: Placed[], i: number, bodyFont: number, pitch: number, bodyFontName: string): boolean {
  // The whole row: the number and title can be separate lines ("C   Prompts").
  let last = i;
  while (stream[last + 1] && sameRow(stream[last].line, stream[last + 1].line)) last++;
  const s = { ...stream[i], text: stream.slice(i, last + 1).map((r) => r.text).join(' ') };
  if (s.line.fontSize >= bodyFont * 1.15 && s.text.length <= 150) return true;
  if (!NUMBERED_HEADING.test(s.text) || s.text.length > 80 || /[-,;:.]$/.test(s.text)) return false;
  if (s.text.split(/\s+/).length > 12) return false;
  // A run-in heading starts a paragraph on the same line ("4.1 Metrics. We …").
  if (/[.:]\s+\S/.test(s.text.replace(NUMBERED_HEADING_PREFIX, ''))) return false;
  // An appendix letter alone ("C Prompts used") only for short lines: "A New
  // method …" can start a sentence.
  if (/^[A-H]\s/.test(s.text) && s.text.split(/\s+/).length > 6) return false;

  const prev = stream[i - 1];
  const next = stream[last + 1];
  const close = (a: Placed, b: Placed) =>
    sameBlock(a.line, b.line) && b.line.baseline - a.line.baseline > 0 && b.line.baseline - a.line.baseline <= 1.3 * pitch;
  // A wrapped line that happens to start with a number ("12 GPUs by …").
  if (prev && close(prev, s) && !ENDS_SENTENCE.test(prev.text)) return false;
  // A numbered list item whose text wraps under a hanging indent.
  // (A heading in its own font wrapped under its number is not.)
  const wrappedTitle = s.line.fontName !== bodyFontName && next?.line.fontName === s.line.fontName;
  if (next && close(s, next) && next.line.box.x > s.line.box.x + 0.8 * s.line.fontSize && !wrappedTitle) return false;
  return true;
}

const sameBlock = (a: Line, b: Line) => a.page === b.page && a.block === b.block;
const sameRow = (a: Line, b: Line) => sameBlock(a, b) && Math.abs(a.baseline - b.baseline) <= 0.5 * Math.min(a.fontSize, b.fontSize);

/** The font most body-size text is set in (the regular body face). */
function dominantFontName(stream: Placed[], bodyFont: number): string {
  const count = new Map<string, number>();
  for (const s of stream) {
    if (Math.abs(s.line.fontSize - bodyFont) < 0.1 * bodyFont) count.set(s.line.fontName, (count.get(s.line.fontName) ?? 0) + s.text.length);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

/**
 * Display-maths lines: a maths symbol with at most one ordinary word, plus
 * short symbol-only lines (sub/superscript rows, "Subject to:") next to them.
 */
function mathLines(stream: Placed[], bodyFont: number, pitch: number): boolean[] {
  const words = (t: string) => (t.match(/\p{L}{3,}/gu) ?? []).filter((w) => !MATH_WORDS.has(w.toLowerCase())).length;
  const prose = (t: string) => /\p{L}{2,}[,;]?\s+\p{L}{2,}[,;]?\s+\p{L}{2,}/u.test(t) || (words(t) >= 4 && /\b(?:the|an?|of|to|in|is|are|we|and|for|with|on|as|by)\b/i.test(t));
  const identifiers = (t: string) => /[_(){}]/.test(t) && !prose(t) && !/[.!?]$/.test(t);
  const math = stream.map(
    (s) =>
      s.line.fontSize < 1.15 * bodyFont &&
      MATH_SYMBOL.test(s.text) &&
      (words(s.text) <= 1 || EQUATION_NUMBER.test(s.text) || identifiers(s.text)),
  );
  const weak = stream.map(
    (s) =>
      s.line.fontSize < 1.15 * bodyFont &&
      !isCaptionLine(s.line, s.text) &&
      ((s.text.replace(/\s/g, '').length <= 12 && words(s.text) <= 1 && !/[.!?]$/.test(s.text)) ||
        (s.text.length <= 60 && identifiers(s.text))),
  );
  const near = (a: Placed, b: Placed) => a.line.page === b.line.page && Math.abs(a.line.baseline - b.line.baseline) <= 3 * pitch;
  for (let changed = true; changed; ) {
    changed = false;
    stream.forEach((s, i) => {
      if (math[i] || !weak[i]) return;
      if ((i > 0 && math[i - 1] && near(stream[i - 1], s)) || (i + 1 < stream.length && math[i + 1] && near(stream[i + 1], s))) {
        math[i] = true;
        changed = true;
      }
    });
  }
  return math;
}

/** A new footnote starts at a superscript mark or a leading number. */
function groupFootnotes(lines: Line[]): Line[][] {
  const groups: Line[][] = [];
  for (const line of lines) {
    const startsNew = line.fragments[0]?.script === 'super' || /^\d+\s/.test(lineText(line));
    if (startsNew || groups.length === 0) groups.push([line]);
    else groups[groups.length - 1].push(line);
  }
  return groups;
}

function linePitch(stream: Placed[], bodyFont: number): number {
  const steps: number[] = [];
  for (let i = 1; i < stream.length; i++) {
    const a = stream[i - 1].line;
    const b = stream[i].line;
    const d = b.baseline - a.baseline;
    if (sameBlock(a, b) && Math.abs(a.fontSize - bodyFont) < 0.1 * bodyFont && d > 0 && d < 3 * bodyFont) steps.push(d);
  }
  return median(steps, 1.2 * bodyFont);
}

function makeUnit(
  id: number,
  items: Item[],
  kind: UnitKind,
  lexicon: Lexicon,
  options: AnalyzeOptions,
  rulesOf: (page: number) => Rule[],
): ReadingUnit {
  let seq: SpokenChar[] = [];
  let afterMath = false;
  let lastLine: Line | null = null;
  for (const item of items) {
    if ('table' in item) {
      if (seq.length) seq.push(SPACE);
      seq.push(...tableChars(item.table, rulesOf(item.table[0].page), (cell, next) => lineJoin(cell, next, lexicon)));
      continue;
    }
    if ('math' in item) {
      if (seq.length) seq.push(SPACE);
      seq.push(...equationChars(item.math, options.readEquationText, seq.length === 0));
      afterMath = true;
      continue;
    }
    const chars = lineChars(item.line);
    if (seq.length) {
      if (afterMath) {
        if (/^\p{Lu}/u.test(chars[0]?.ch ?? '')) seq.push({ ch: '.', box: null });
        seq.push(SPACE);
      } else if (
        URL_TOKEN.test(tail(seq)) &&
        lastLine &&
        sameBlock(lastLine, item.line) &&
        item.line.baseline > lastLine.baseline + 1 &&
        // The rest of an address, not a sentence going on ("Answer: [Yes]").
        !/^\p{Lu}\p{Ll}+[:,]?(?:\s|$)/u.test(chars.map((c) => c.ch).join(''))
      ) {
        // URLs are broken after "/", "." or "-" with nothing inserted.
      } else {
        const join = lineJoin(seq, chars, lexicon);
        if (join === 'join') seq.pop();
        else if (join === 'space') seq.push(SPACE);
      }
    }
    afterMath = false;
    lastLine = item.line;
    seq.push(...chars);
  }
  seq = normalizeChars(seq);
  seq = replaceAll(seq, BROKEN_TH, 'Th');
  seq = replaceAll(seq, BROKEN_LIGATURE, (m) => repairLigatures(m, lexicon));
  for (const [re, rep] of LIST_MARKERS) seq = replaceAll(seq, re, rep);
  // A reference list entry: "[12] Author…" is read "12. Author…".
  seq = replaceAll(seq, /^\[(\d+)\]\s*/g, (m) => `${m.match(/\d+/)![0]}. `);
  if (options.skipCitations) seq = replaceAll(seq, CITATION_PATTERN, (m) => (isCitation(m) ? '' : m));
  if (options.expandAbbreviations) for (const [re, rep] of ABBREVIATIONS) seq = replaceAll(seq, re, rep);
  seq = collapseSpaces(seq);

  const text = seq.map((c) => c.ch).join('');
  return { id, kind, text, boxes: seq.map((c) => c.box), sentences: splitSentences(text) };
}

const SPACE: SpokenChar = { ch: ' ', box: null };

const tail = (seq: SpokenChar[]) => seq.slice(-200).map((c) => c.ch).join('');

/**
 * Display maths as speech: "equation 3" (or the raw text when asked), with
 * the spoken characters spread over the equation's glyphs so the highlight
 * covers the formula while it is announced.
 */
function equationChars(lines: Line[], raw: boolean, standalone: boolean): SpokenChar[] {
  const glyphs = lines.flatMap((l) => lineChars(l, true));
  if (raw) {
    const out: SpokenChar[] = [];
    lines.forEach((l, i) => {
      if (i) out.push(SPACE);
      out.push(...lineChars(l, true));
    });
    return out;
  }
  const numbers = lines.map((l) => lineText(l).match(EQUATION_NUMBER)?.[1]).filter((n): n is string => !!n);
  let spoken = numbers.length === 0 ? 'equation' : numbers.length === 1 ? `equation ${numbers[0]}` : `equations ${listOf(numbers)}`;
  if (standalone) spoken = `${spoken[0].toUpperCase()}${spoken.slice(1)}.`;
  const boxes = glyphs.map((g) => g.box).filter((b): b is CharBox => b !== null);
  return [...spoken].map((ch, i) => ({ ch, box: boxes[Math.floor((i * boxes.length) / spoken.length)] ?? null }));
}

const listOf = (items: string[]) => `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * "[3]", "[3,2,1,44,55]", "[4–9, 12]", "[3; 5]", "[Smi20, Doe21]", "[3]–[5]".
 * Every item must be a reference number (1–9999, or a range of them) or an
 * author-year key, so "[0, 1]", "[0.5, 2]" and "a[i]" are kept.
 */
export function isCitation(match: string): boolean {
  const groups = [...match.matchAll(/\[([^[\]]*)\]/g)].map((g) => g[1]);
  return groups.every((g) => {
    const items = g.split(/[,;]/).map((item) => item.trim());
    return items.length > 0 && items.every((item) => CITATION_ITEM.test(item));
  });
}

/** "https://aws.amazon.com/about-aws/…" -> "link to aws.amazon.com". */
function speakUrl(url: string): string {
  const trailing = url.match(/[.,;:)\]]+$/)?.[0] ?? '';
  const host = url
    .slice(0, url.length - trailing.length)
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0];
  return `link to ${host}${trailing}`;
}
