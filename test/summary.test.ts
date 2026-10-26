import { describe, expect, it } from 'vitest';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { analyzeDocument, extractPage, keySentences, pagesOf, sectionsOf, type PageText, type ReadingUnit, type UnitKind } from '../src/engine';
import { splitSentences } from '../src/engine/sentences';
// @ts-expect-error plain JS fixture script
import { buildFixturePdf } from '../scripts/make-fixture.mjs';

const unit = (kind: UnitKind, text: string, page = 0): ReadingUnit => ({
  id: 0,
  kind,
  text,
  boxes: [...text].map(() => ({ page, x: 0, y: 0, w: 1, h: 1 })),
  sentences: splitSentences(text),
});
const numbered = (units: ReadingUnit[]) => units.map((u, id) => ({ ...u, id }));
const titles = (units: ReadingUnit[]) => sectionsOf(numbered(units)).map((s) => [s.kind, s.level, s.title]);

describe('sections', () => {
  it('splits the fixture paper at its section headings', async () => {
    const doc = await getDocument({ data: buildFixturePdf(), verbosity: 0, fontExtraProperties: true }).promise;
    const pages: PageText[] = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push(await extractPage(await doc.getPage(i), i - 1, undefined, OPS));
    const sections = sectionsOf(analyzeDocument(pages).units);
    expect(sections.map((s) => [s.kind, s.level, s.title, s.first, s.end])).toEqual([
      ['front', 0, 'Column-Aware Reading Order for Spoken PDFs', 0, 2],
      ['body', 1, 'Abstract', 2, 3],
      ['body', 1, '1 Introduction', 3, 6],
      ['body', 1, '2 Method', 6, 10],
      ['body', 1, '3 Results', 10, 15],
      ['body', 3, '4.2.1 Scalability', 15, 25],
      ['references', 1, 'References', 25, 28],
      ['body', 1, 'Appendix', 28, 34],
    ]);
    expect(sections[0].pages).toEqual([0, 0]);
  });

  it('keeps author lines, affiliations and numbered questions inside a section', () => {
    expect(
      titles([
        unit('heading', 'Panoptic Segmentation'),
        unit('heading', 'Facebook AI Research (FAIR) HCI/IWR, Heidelberg University, Germany'),
        unit('heading', 'Abstract'),
        unit('paragraph', 'We propose a task.'),
        unit('heading', '1. Introduction'),
        unit('heading', '2. Related Work'),
        unit('heading', '2.1. Datasets'),
        unit('heading', '3. Evaluation'),
        unit('heading', '1. What are the important workload statistics?'),
        unit('heading', '2 Can it scale'),
        unit('heading', '4. Conclusion'),
      ]),
    ).toEqual([
      ['front', 0, 'Panoptic Segmentation'],
      ['body', 1, 'Abstract'],
      ['body', 1, '1. Introduction'],
      ['body', 1, '2. Related Work'],
      ['body', 2, '2.1. Datasets'],
      ['body', 1, '3. Evaluation'],
      ['body', 1, '4. Conclusion'],
    ]);
  });

  it('reads Roman numerals, section names set in body text, and lettered appendices', () => {
    expect(
      titles([
        unit('heading', 'A Study of Things'),
        unit('paragraph', 'Abstract—We study things.'),
        unit('heading', 'I. INTRODUCTION'),
        unit('heading', 'II. DESIGN'),
        unit('paragraph', 'ACKNOWLEDGMENT'),
        unit('heading', 'References'),
        unit('heading', 'A Proofs'),
        unit('heading', 'A.1 Lemma One'),
      ]),
    ).toEqual([
      ['front', 0, 'A Study of Things'],
      ['body', 1, 'Abstract'],
      ['body', 1, 'I. INTRODUCTION'],
      ['body', 1, 'II. DESIGN'],
      ['body', 1, 'ACKNOWLEDGMENT'],
      ['references', 1, 'References'],
      ['body', 1, 'A Proofs'],
      ['body', 2, 'A.1 Lemma One'],
    ]);
  });

  it('groups units by the page they start on', () => {
    const pages = pagesOf(numbered([unit('heading', 'Title', 0), unit('paragraph', 'One.', 0), unit('paragraph', 'Two.', 1), unit('paragraph', 'Three.', 2)]));
    expect(pages.map((p) => [p.title, p.first, p.end])).toEqual([
      ['Page 1', 0, 2],
      ['Page 2', 2, 3],
      ['Page 3', 3, 4],
    ]);
  });
});

describe('key sentences', () => {
  const paper = numbered([
    unit('heading', 'Fast Video Queries'),
    unit('paragraph', 'Jane Doe, John Roe Stanford University'),
    unit('heading', '1 Introduction'),
    unit(
      'paragraph',
      'Video is everywhere and cameras record more of it every year. ' +
        'Analysing video with neural networks is accurate but expensive. ' +
        'In this paper we present a system that answers video queries with specialized models that are much cheaper than the reference network. ' +
        'Specialized models mimic the reference network on one video and one query. ' +
        'This makes them fast. ' +
        'The weather was pleasant during the recording of several of the videos we used. ' +
        'Specialized models and difference detection together answer video queries up to a thousand times faster.',
    ),
    unit('paragraph', 'Our code is open source and runs on a single graphics card in a normal desktop.'),
    unit('heading', '2 Difference Detection'),
    unit('paragraph', 'A difference detector skips frames that look like the previous frame. It compares the pixels of the two frames.'),
    unit('heading', 'References'),
    unit('paragraph', '1. J. Doe and J. Roe. Specialized models for video queries and fast video detection. In VLDB, 2017.'),
  ]);
  const sections = sectionsOf(paper);
  const keys = keySentences(paper, sections);
  const texts = keys.map((list) => list.map((k) => k.text));

  it('picks the sentences most typical of each section, in reading order', () => {
    expect(texts[1]).toEqual([
      'In this paper we present a system that answers video queries with specialized models that are much cheaper than the reference network.',
    ]);
    expect(texts[2]).toEqual(['A difference detector skips frames that look like the previous frame.', 'It compares the pixels of the two frames.']);
  });

  it('points at the sentence in its unit, for reading from there', () => {
    const [k] = keys[1];
    expect(paper[k.unit].text.slice(k.start, k.end)).toBe(k.text);
  });

  it('summarises neither the title part nor the reference list', () => {
    expect(texts[0]).toEqual([]);
    expect(texts[3]).toEqual([]);
  });

  it('takes an abstract run into the author lines from "Abstract" on', () => {
    const merged = numbered([
      unit('heading', 'Shoggoth'),
      unit('paragraph', 'Jane Doe University of Somewhere Abstract—We adapt edge models to drifting video with online distillation in the cloud.'),
      unit('heading', 'I. INTRODUCTION'),
      unit('paragraph', 'Video analytics runs on edge devices with small models.'),
    ]);
    const [front] = keySentences(merged, sectionsOf(merged));
    expect(front.map((k) => k.text)).toEqual(['We adapt edge models to drifting video with online distillation in the cloud.']);
  });
});
