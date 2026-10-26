import type { ReadingUnit } from './types';

/** A stretch of the reading units summarised together: a section, or a page. */
export interface Section {
  title: string;
  /** 0 for the title part and for pages; 1 for sections, 2 and more for subsections. */
  level: number;
  /** The title part (title, authors) and the reference list get no summary. */
  kind: 'front' | 'body' | 'references' | 'page';
  /** Units `first` to `end` (exclusive). */
  first: number;
  end: number;
  /** First and last page it covers, 0-based. */
  pages: [number, number];
}

// "3 Method", "3.2. Cost Model", "IV. EVALUATION", and in appendices "A Proofs", "B.1 Data".
const NUMBERED = /^(?:(\d{1,2}(?:\.\d{1,2})*)\.?|([IVX]{1,6})\.|([A-Z](?:\.\d{1,2})*)\.?)\s+(\S.*)$/;
const NAMED =
  /^(?:abstract|introduction|background|motivation|overview|related work|discussion|limitations|evaluation|experiments|conclusions?(?: and future work)?|future work|acknowledge?ments?|references|bibliography|appendix|appendices|supplementary material)$|^appendix\b/i;
const REFERENCES = /^(?:references|bibliography)$/i;
/** Run into their paragraph: "Abstract. We …", "ABSTRACT Vision …", "Acknowledgments. This work …". */
const ABSTRACT_START = /^abstract(?:\s*[.:—–-]|\s+\p{Lu})/iu;
const ACKNOWLEDGEMENTS_START = /^acknowledge?ments?(?:\s*[.:—–-]|\s+\p{Lu})/iu;
const MAX_TITLE = 120;

/** What a heading starts, if it starts a section: its level and its title without the number. */
interface Start {
  level: number;
  name: string;
  /** The top-level number, to check numbers go up in order. */
  top?: number;
  lettered?: boolean;
}

function parseHeading(text: string): Start | null {
  if (text.length > MAX_TITLE || /[?]$/.test(text)) return null;
  const m = NUMBERED.exec(text);
  if (m && /^\p{Lu}/u.test(m[4])) {
    const [, arabic, roman, letter, name] = m;
    if (arabic) {
      const parts = arabic.split('.').map(Number);
      return { level: parts.length, name, top: parts[0] };
    }
    if (roman) return { level: 1, name, top: romanValue(roman) };
    if (letter) return { level: letter.split('.').length, name, lettered: true };
  }
  return NAMED.test(text) ? { level: 1, name: text } : null;
}

function romanValue(s: string): number {
  const v: Record<string, number> = { I: 1, V: 5, X: 10 };
  let n = 0;
  for (let i = 0; i < s.length; i++) n += v[s[i]] < (v[s[i + 1]] ?? 0) ? -v[s[i]] : v[s[i]];
  return n;
}

/** First and last page a unit is on. */
function unitPages(unit: ReadingUnit): [number, number] | null {
  const boxes = unit.boxes.filter((b) => b !== null);
  return boxes.length ? [boxes[0].page, boxes[boxes.length - 1].page] : null;
}

function spanPages(units: ReadingUnit[], first: number, end: number): [number, number] {
  let from = Infinity;
  let to = -Infinity;
  for (let i = first; i < end; i++) {
    const p = unitPages(units[i]);
    if (!p) continue;
    from = Math.min(from, p[0]);
    to = Math.max(to, p[1]);
  }
  return from === Infinity ? [0, 0] : [from, to];
}

/**
 * The document's sections, in reading order, covering every unit: the title
 * part first, then one per section heading. Only numbered headings that go up
 * in order ("1", "2", "2.1", "3"…) and the usual unnumbered ones (Abstract,
 * References, Acknowledgements…) start a section; other headings (author
 * lines, affiliations, run-in questions) stay inside the section they are in.
 */
export function sectionsOf(units: ReadingUnit[]): Section[] {
  const starts: { unit: number; title: string; level: number; references: boolean }[] = [];
  let top = 0;
  let appendix = false;
  units.forEach((unit, i) => {
    const text = unit.text.trim();
    if (unit.kind === 'paragraph') {
      // Section names set in body text ("ACKNOWLEDGMENT"), and run into it.
      const title =
        NAMED.test(text) && text.length < 40
          ? text
          : !starts.length && ABSTRACT_START.test(text)
            ? 'Abstract'
            : ACKNOWLEDGEMENTS_START.test(text)
              ? 'Acknowledgements'
              : null;
      if (title) starts.push({ unit: i, title, level: 1, references: REFERENCES.test(title) });
      return;
    }
    if (unit.kind !== 'heading') return;
    const start = parseHeading(text);
    if (!start) return;
    if (start.lettered && !appendix) return;
    if (start.top !== undefined) {
      const inOrder = start.level === 1 ? start.top === top + 1 || start.top === top + 2 : start.top === top || start.top === top + 1;
      if (!inOrder && !appendix) return;
      if (!appendix) top = start.top;
    }
    const references = REFERENCES.test(start.name);
    if (references || /^append/i.test(start.name)) appendix = true;
    starts.push({ unit: i, title: text, level: start.level, references });
  });

  const sections: Section[] = [];
  const firstStart = starts[0]?.unit ?? units.length;
  if (firstStart > 0) {
    const title = units.find((u) => u.kind === 'heading')?.text.trim();
    sections.push({ title: title ?? 'Title and authors', level: 0, kind: 'front', first: 0, end: firstStart, pages: spanPages(units, 0, firstStart) });
  }
  starts.forEach((s, k) => {
    const end = starts[k + 1]?.unit ?? units.length;
    sections.push({ title: s.title, level: s.level, kind: s.references ? 'references' : 'body', first: s.unit, end, pages: spanPages(units, s.unit, end) });
  });
  return sections;
}

/** One group per page, by the page each unit starts on. */
export function pagesOf(units: ReadingUnit[]): Section[] {
  const pages: Section[] = [];
  units.forEach((unit, i) => {
    const page = unitPages(unit)?.[0];
    const last = pages[pages.length - 1];
    if (last && (page === undefined || page === last.pages[0])) {
      last.end = i + 1;
      return;
    }
    const p = page ?? 0;
    pages.push({ title: `Page ${p + 1}`, level: 0, kind: 'page', first: i, end: i + 1, pages: [p, p] });
  });
  for (const s of pages) s.pages = spanPages(units, s.first, s.end);
  return pages;
}
