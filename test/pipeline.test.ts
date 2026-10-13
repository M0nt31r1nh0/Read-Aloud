// End to end: real PDF bytes -> pdf.js text layer -> reading units.
import { describe, expect, it } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzeDocument, DEFAULT_OPTIONS, extractPage, type PageText } from '../src/engine';
// @ts-expect-error plain JS fixture script
import { buildFixturePdf, EXPECTED_TABLES, EXPECTED_UNITS } from '../scripts/make-fixture.mjs';
// @ts-expect-error plain JS helper
import { readDictionaryWords } from '../scripts/dictionary-source.mjs';

async function loadPages(data: Uint8Array): Promise<PageText[]> {
  const doc = await getDocument({ data, verbosity: 0 }).promise;
  const pages: PageText[] = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push(await extractPage(await doc.getPage(i), i - 1, undefined, OPS));
  return pages;
}

describe('two-column paper fixture', async () => {
  const pages = await loadPages(buildFixturePdf());
  const analysis = analyzeDocument(pages);

  it('reads units in human reading order with clean text', () => {
    expect(analysis.units.map((u) => [u.kind, u.text])).toEqual(EXPECTED_UNITS);
  });

  it('gives the same result with the full English dictionary', () => {
    const words = new Set(readDictionaryWords() as string[]);
    expect(analyzeDocument(pages, DEFAULT_OPTIONS, words).units.map((u) => [u.kind, u.text])).toEqual(EXPECTED_UNITS);
  });

  it('drops the running header and page numbers', () => {
    const dropped = analysis.pages.flatMap((p) => p.dropped.length);
    // Page 3 also skips 2 figure labels and 6 table cells; page 4 two tables (12 + 9 lines).
    expect(dropped).toEqual([2, 2, 10, 23]);
  });

  it('reads display maths as text when asked', () => {
    const raw = analyzeDocument(pages, { ...DEFAULT_OPTIONS, readEquationText: true });
    expect(raw.units.find((u) => u.kind === 'equation')?.text).toBe('x = a + b (1)');
  });

  it('maps the equation placeholder onto the formula glyphs', () => {
    const unit = analysis.units.find((u) => u.kind === 'equation')!;
    expect(unit.boxes.every((b) => b !== null && b.page === 1 && b.x > 300)).toBe(true);
  });

  describe('options', () => {
    const texts = (options: Partial<typeof DEFAULT_OPTIONS>) =>
      analyzeDocument(pages, { ...DEFAULT_OPTIONS, ...options }).units.map((u) => [u.kind, u.text]);

    it('keeps citations when asked, including lists broken across lines', () => {
      const all = texts({ skipCitations: false }).map(([, t]) => t);
      expect(all).toContain('Prior systems [7, 8, 12] read in stream order.');
      expect(all).toContain('The online voice made no errors [3,2,1,44,55].');
      expect(all.some((t) => t.includes('end of a line [3]. A naive'))).toBe(true);
      expect(texts({}).flat().join(' ')).not.toMatch(/\[\d/);
    });

    it('skips figure and table captions', () => {
      const kinds = texts({ skipCaptions: true }).map(([k]) => k);
      expect(kinds).not.toContain('caption');
      expect(texts({}).filter(([k]) => k === 'caption').map(([, t]) => t)).toEqual([
        'Figure 3: A caption placed inside the paragraph.',
        'Figure 5: Load over time.',
        'Table 1: Results per voice.',
        'Table 2: Design space.',
        'Table 3: Related work.',
      ]);
    });

    it('skips table cells by default and reads them row by row when asked', () => {
      expect(texts({}).some(([, t]) => t.includes('Samantha'))).toBe(false);
      const read = texts({ skipTables: false });
      const caption = read.findIndex(([, t]) => t === 'Table 1: Results per voice.');
      expect(read[caption + 1]).toEqual(['table', 'Voice, Errors. Samantha: Errors, 3. Ava (online): Errors, 0.']);
      expect(read[caption - 1]).toEqual(['paragraph', 'Prior systems read in stream order.']);
    });

    it('reads bordered and booktabs tables with their headers', () => {
      const read = texts({ skipTables: false });
      // Only words printed in the tables are spoken.
      expect(read.filter(([k]) => k === 'table').some(([, t]) => /\b(Columns|Rows)\b/.test(t))).toBe(false);
      for (const [i, caption] of ['Table 2: Design space.', 'Table 3: Related work.'].entries()) {
        const at = read.findIndex(([, t]) => t === caption);
        expect(read[at + 1]).toEqual(['table', EXPECTED_TABLES[i]]);
      }
    });

    it('skips captions and tables together, leaving the text flow intact', () => {
      const flow = texts({ skipCaptions: true, skipTables: true }).map(([, t]) => t);
      const i = flow.indexOf('Prior systems read in stream order.');
      expect(flow[i + 1]).toBe('The online voice made no errors.');
    });
  });

  it('maps a word joined across a line break back to both lines', () => {
    const unit = analysis.units.find((u) => u.text.startsWith('We group lines'))!;
    const start = unit.text.indexOf('Hyphenated');
    const boxes = unit.boxes.slice(start, start + 'Hyphenated'.length);
    expect(boxes.every((b) => b !== null)).toBe(true);
    const lineTops = new Set(boxes.map((b) => Math.round(b!.y)));
    expect(lineTops.size).toBe(2); // "Hyphen" on one line, "ated" on the next
  });

  it('maps a word joined across the page break to both pages', () => {
    const unit = analysis.units.find((u) => u.text.startsWith('Columns are then'))!;
    const start = unit.text.indexOf('synthesizer');
    const pagesOfWord = new Set(unit.boxes.slice(start, start + 'synthesizer'.length).map((b) => b!.page));
    expect([...pagesOfWord].sort()).toEqual([0, 1]);
  });

  it('splits sentences without breaking at abbreviations', () => {
    const unit = analysis.units.find((u) => u.text.startsWith('The reading order'))!;
    const sentences = unit.sentences.map((s) => unit.text.slice(s.start, s.end));
    expect(sentences).toEqual([
      'The reading order was correct for all pages.',
      'We used the e-mail corpus from Smith et al. and the pre-processing steps.',
    ]);
  });

  it('finds two columns under the full-width header on page 1', () => {
    const kinds = analysis.pages[0].blocks.map((b) => b.kind);
    expect(kinds.filter((k) => k === 'column').length).toBeGreaterThanOrEqual(2);
    expect(kinds[0]).toBe('full');
  });
});
