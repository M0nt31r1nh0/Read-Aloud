import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Lexicon, lineJoin } from '../src/engine/hyphenation';
import { splitSentences } from '../src/engine/sentences';
import { replaceAll, type SpokenChar } from '../src/engine/text';
import { AUTHOR_YEAR_PATTERN, CITATION_PATTERN, NARRATIVE_YEAR_PATTERN, isAuthorYearCitation, isCitation } from '../src/engine/units';
import { DEFAULT_OPTIONS, extractPage } from '../src/engine';
// @ts-expect-error plain JS fixture script
import { buildFixturePdf } from '../scripts/make-fixture.mjs';

const chars = (text: string, page = 0): SpokenChar[] =>
  [...text].map((ch, i) => ({ ch, box: { page, x: i * 5, y: 0, w: 5, h: 10 } }));

describe('line-end hyphens', () => {
  const lexicon = new Lexicon();
  lexicon.addLine('papers with a two-column layout and a well-known trick');
  lexicon.addLine('the preprocessing step');

  it('joins ordinary hyphenation', () => {
    expect(lineJoin(chars('are fre-'), chars('quently used'), lexicon)).toBe('join');
  });

  it('keeps compounds the document writes with a hyphen', () => {
    expect(lineJoin(chars('the two-'), chars('column page'), lexicon)).toBe('keep');
  });

  it('joins when the document writes the word solid', () => {
    expect(lineJoin(chars('the pre-'), chars('processing step'), lexicon)).toBe('join');
  });

  it('keeps the hyphen between two words the document uses on their own', () => {
    const words = new Lexicon();
    words.addLine('a general rule that we improve and train often');
    expect(lineJoin(chars('the general-'), chars('purpose schedulers'), words)).toBe('keep');
    expect(lineJoin(chars('during train-'), chars('ing jobs'), words)).toBe('join');
    expect(lineJoin(chars('an improve-'), chars('ment here'), words)).toBe('join');
    expect(lineJoin(chars('by Chris-'), chars('tian Smith'), words)).toBe('join');
  });

  it('does not learn word halves from hyphenated line breaks', () => {
    const words = new Lexicon();
    words.addLine('we saw an improve-');
    words.addLine('ment and then more text');
    expect(lineJoin(chars('the improve-'), chars('ment again'), words)).toBe('join');
  });

  it('keeps hyphens inside an existing compound', () => {
    expect(lineJoin(chars('state-of-the-'), chars('art results'), lexicon)).toBe('keep');
  });

  it('keeps the hyphen before capitals and digits', () => {
    expect(lineJoin(chars('COVID-'), chars('19 cases'), lexicon)).toBe('keep');
  });

  it('treats a spaced dash as punctuation', () => {
    expect(lineJoin(chars('results -'), chars('as shown'), lexicon)).toBe('space');
  });
});

describe('line-end hyphens with a dictionary', () => {
  const dictionary = new Set(['general', 'purpose', 'data', 'access', 'frequently', 'improvement', 'improve',
    'christian', 'chris', 'bren', 'don', 'real', 'time', 'train', 'training', 'scheduling', 'every', 'thing', 'everything', 'based']);
  const decide = (left: string, right: string, doc = '') => {
    const lexicon = new Lexicon(dictionary);
    if (doc) lexicon.addLine(doc);
    return lineJoin(chars(left), chars(right), lexicon);
  };

  it('keeps the hyphen between two words that are not one word', () => {
    expect(decide('used by general-', 'purpose schedulers')).toBe('keep');
    expect(decide('the data-', 'access path')).toBe('keep');
  });

  it('joins when the joined form is a word', () => {
    expect(decide('it is fre-', 'quently used')).toBe('join');
    expect(decide('an improve-', 'ment here')).toBe('join');
    expect(decide('during train-', 'ing jobs')).toBe('join');
    expect(decide('know every-', 'thing now')).toBe('join');
  });

  it('joins names split inside a sentence, but not compounds that start one', () => {
    expect(decide('by Bren-', 'don Smith')).toBe('join');
    expect(decide('and Chris-', 'tian Doe')).toBe('join');
    expect(decide('Done. Real-', 'time systems')).toBe('keep');
    expect(decide('an ANFIS-', 'based model')).toBe('keep');
  });

  it('lets the document overrule the dictionary', () => {
    expect(decide('the general-', 'purpose case', 'a generalpurpose design')).toBe('join');
    expect(decide('the fre-', 'quently case', 'a fre-quently weird spelling')).toBe('keep');
  });

  it('also counts words the document uses on their own', () => {
    expect(decide('ann- and anfis-', 'based models', 'we compare ANFIS with others')).toBe('keep');
  });

  it('joins fragments that are not words', () => {
    expect(decide('the sched-', 'uling loop')).toBe('join');
  });
});

describe('citations', () => {
  const strip = (text: string) => replaceAll(chars(text), CITATION_PATTERN, (m) => (isCitation(m) ? '' : m)).map((c) => c.ch).join('');

  it.each([
    ['at the end of a line [3]. A', 'at the end of a line. A'],
    ['as shown [3,2,1,44,55].', 'as shown.'],
    ['as shown [3, 2, 1, 44, 55].', 'as shown.'],
    ['ranges [4–9] and [4-9, 12] too', 'ranges and too'],
    ['semicolons [3; 5] too', 'semicolons too'],
    ['ranges [3]–[5] too', 'ranges too'],
    ['no space work[3].', 'no space work.'],
    ['author keys [Smi20, Doe21a] too', 'author keys too'],
  ])('removes %j', (input, expected) => expect(strip(input)).toBe(expected));

  it.each([['the range [0, 1] is kept'], ['weights [0.5, 2] are kept'], ['an index a[i] is kept'], ['a note [see above] is kept']])(
    'keeps %j',
    (input) => expect(strip(input)).toBe(input),
  );
});

describe('author-year citations', () => {
  const strip = (text: string) => {
    let seq = replaceAll(chars(text), AUTHOR_YEAR_PATTERN, (m) => (isAuthorYearCitation(m) ? '' : m));
    seq = replaceAll(seq, NARRATIVE_YEAR_PATTERN, '');
    return seq.map((c) => c.ch).join('');
  };

  it.each([
    ['organisational defence (Ismail et al., 2025; Knerler et al., 2022; Singh et al., 2024). At', 'organisational defence. At'],
    ['ever since (Baruwal Chhetri et al., 2024; Jalalvand et al., 2024). As', 'ever since. As'],
    ['in various forms (Tilbury & Flowerday, 2024b). At', 'in various forms. At'],
    ['labels (de Gibert et al., 2018).', 'labels.'],
    ['edge deployment (Yao et al. 2024; Rang et al. 2025), enabling', 'edge deployment, enabling'],
    ['caching (Ramírez et al., 2023; Stogiannidis et al., 2023).', 'caching.'],
    ['as before (e.g., Smith and Jones, 2020, 2021).', 'as before.'],
    ['explored in various works [Weng et al., 2022; Jiang et al., 2023].', 'explored in various works.'],
    ['using an API (OpenAI, 2023).', 'using an API.'],
    ['conceptualized by Hinton et al. (2015), emerged', 'conceptualized by Hinton et al., emerged'],
    ['Varshney & Baral (2022) systematically examines', 'Varshney & Baral systematically examines'],
  ])('removes %j', (input, expected) => expect(strip(input)).toBe(expected));

  it('keeps years in the reference list, and its entries low on the page are not footnotes', async () => {
    const { analyzeDocument } = await import('../src/engine');
    const run = (text: string, y: number, fontSize = 10) => ({
      page: 0, text, x: 72, top: y, width: text.length * 0.5 * fontSize, height: fontSize, baseline: y + 0.8 * fontSize, fontSize, fontName: 'f',
      chars: [...text].map((_, i) => ({ x: 72 + 0.5 * fontSize * i, y, w: 0.5 * fontSize, h: fontSize })),
    });
    const body = Array.from({ length: 8 }, (_, i) => run(i ? 'and the results improve on the baseline in every one of the settings.' : 'As shown before (Smith et al., 2020; Doe, 2021), this works well.', 100 + 12 * i));
    const refs = ['Ada Lovelace. Notes on the engine. ICML (2021).', 'Alan Turing. On computable numbers. NeurIPS (2017).'].map((t, i) => run(t, 600 + 12 * i, 8));
    const page = { page: 0, width: 612, height: 792, rules: [], fragments: [...body, run('References', 560, 12), ...refs] };
    const units = analyzeDocument([page]).units.map((u) => `${u.kind}: ${u.text}`);
    expect(units[0]).toMatch(/^paragraph: As shown before, this works well\. and/);
    expect(units.join(' ')).toContain('ICML (2021).');
    expect(units.join(' ')).toContain('NeurIPS (2017).');
    expect(units.some((u) => u.startsWith('footnote'))).toBe(false);
  });

  it.each([
    ['the survey (May 2023) found'],
    ['published at a venue (ICML 2024) last year'],
    ['the model (GPT-4, 2023) is used'],
    ['values (0.5, 2020) are kept'],
    ['in Section 4 (2020 data) we'],
  ])('keeps %j', (input) => expect(strip(input)).toBe(input));
});

describe('text edits keep page boxes', () => {
  it('maps an expanded abbreviation onto the original glyphs', () => {
    const seq = replaceAll(chars('see Fig. 2 now'), /\bFig\.(?=\s*\d)/g, 'Figure');
    const text = seq.map((c) => c.ch).join('');
    expect(text).toBe('see Figure 2 now');
    const figure = seq.slice(4, 10).map((c) => c.box!.x);
    expect(Math.min(...figure)).toBe(20); // "F" of "Fig."
    expect(Math.max(...figure)).toBe(35); // "." of "Fig."
    expect(seq[11].box!.x).toBe(45); // "2" is untouched
  });
});

describe('broken "Th" ligature', () => {
  it('repairs words but leaves maths alone', async () => {
    const { buildUnits } = await import('../src/engine/units');
    const line = (text: string, baseline: number) => {
      const chars = [...text].map((_, i) => ({ x: 50 + i * 5, y: baseline - 8, w: 5, h: 10 }));
      const fragment = { page: 0, text, x: 50, top: baseline - 8, width: text.length * 5, height: 10, baseline, fontSize: 10, fontName: 'f', chars };
      return { page: 0, fragments: [fragment], box: { x: 50, y: baseline - 8, w: text.length * 5, h: 10 }, baseline, fontSize: 10, fontName: 'f', block: 0 };
    };
    const page = {
      page: 0, width: 612, height: 792, dropped: [], rules: [],
      blocks: [{ page: 0, order: 0, kind: 'full' as const, box: { x: 50, y: 0, w: 500, h: 792 } }],
      lines: [line('+e results hold. +erefore we stop.', 100)],
    };
    const [unit] = buildUnits([page], 10, { ...DEFAULT_OPTIONS, readEquationText: true });
    expect(unit.text).toBe('The results hold. Therefore we stop.');
    const math = buildUnits([{ ...page, lines: [line('cost = a +w b', 100)] }], 10, { ...DEFAULT_OPTIONS, readEquationText: true });
    expect(math[0].text).toBe('cost = a +w b');
  });
});

describe('headings', () => {
  const line = (text: string, baseline: number, x = 50, fontSize = 10, fontName = 'f') => {
    const chars = [...text].map((_, i) => ({ x: x + i * 5, y: baseline - 8, w: 5, h: 10 }));
    const fragment = { page: 0, text, x, top: baseline - 8, width: text.length * 5, height: 10, baseline, fontSize, fontName, chars };
    return { page: 0, fragments: [fragment], box: { x, y: baseline - 8, w: text.length * 5, h: 10 }, baseline, fontSize, fontName, block: 0 };
  };
  const body = 'The body text of this paragraph goes on for a while, long enough to set the body font.';
  const read = async (lines: ReturnType<typeof line>[]) => {
    const { buildUnits } = await import('../src/engine/units');
    const page = {
      page: 0, width: 612, height: 792, dropped: [], rules: [], lines,
      blocks: [{ page: 0, order: 0, kind: 'full' as const, box: { x: 50, y: 0, w: 500, h: 792 } }],
    };
    return buildUnits([page], 10, DEFAULT_OPTIONS).map((u) => [u.kind, u.text]);
  };

  it('reads an appendix heading split at a wide space as one heading', async () => {
    const units = await read([line(body, 100), line('C', 140, 50, 11), line('Prompts used', 140, 70, 11), line(body, 160)]);
    expect(units[1]).toEqual(['heading', 'C Prompts used']);
  });

  it('finds letter-numbered and long body-size headings', async () => {
    const units = await read([line(body, 100), line('B.3 Effect of confirmation bias in neural caching with retraining', 130), line(body, 150)]);
    expect(units[1]).toEqual(['heading', 'B.3 Effect of confirmation bias in neural caching with retraining']);
  });

  it('keeps a run-in heading with its paragraph', async () => {
    const units = await read([line(body, 100), line('4.1.2 Evaluation Metrics. We follow recent related works', 130), line(body, 142)]);
    expect(units[1][0]).toBe('paragraph');
    expect(units[1][1]).toMatch(/^4\.1\.2 Evaluation Metrics\. We follow/);
  });

  it('joins a bold heading wrapped under its number', async () => {
    const units = await read([
      line(body, 100),
      line('5.1 Neural Caching without Student', 130, 50, 10, 'bold'),
      line('Retraining', 142, 75, 10, 'bold'),
      line(body, 160),
      line(body, 172),
    ]);
    expect(units[1]).toEqual(['heading', '5.1 Neural Caching without Student Retraining']);
  });
});

describe('reading order', () => {
  const line = (text: string, x: number, y: number, w: number, fontSize = 10) => {
    const fragment = { page: 0, text, x, top: y, width: w, height: fontSize, baseline: y + 0.8 * fontSize, fontSize, fontName: 'f', chars: [] };
    return { page: 0, fragments: [fragment], box: { x, y, w, h: fontSize }, baseline: y + 0.8 * fontSize, fontSize, fontName: 'f' };
  };

  it('reads the left column first when a table beside the right column ends level with a paragraph break', async () => {
    // nie24a page 9: Table 2 (three cell columns) in the left column, beside
    // the right column's first paragraph, which ends at the table's bottom.
    // The cell gaps stop where the left column's text starts; the gutter
    // between the text columns goes on.
    const { orderLines } = await import('../src/engine/columns');
    const table = Array.from({ length: 5 }, (_, r) => [
      line(`cell ${r}a`, 60, 237 + 12 * r, 120),
      line(`cell ${r}b`, 188, 237 + 12 * r, 47),
      line(`cell ${r}c`, 244, 237 + 12 * r, 40),
    ]).flat();
    const rightTop = Array.from({ length: 6 }, (_, i) => line(`right top ${i}`, 307, 237 + 12 * i, i === 5 ? 84 : 234));
    const left = Array.from({ length: 25 }, (_, i) => line(`left ${i}`, 55, 313 + 12 * i, 234));
    const rightRest = Array.from({ length: 24 }, (_, i) => line(`right ${i}`, 307, 321 + 12 * i, 234));
    const { ordered } = orderLines([...rightRest, ...left, ...rightTop, ...table], 0);
    const order = ordered.map((l) => l.fragments[0].text).filter((t) => !t.startsWith('cell'));
    expect(order).toEqual([...left, ...rightTop, ...rightRest].map((l) => l.fragments[0].text));
    // The table is still read before the text below it, row by row.
    const names = ordered.map((l) => l.fragments[0].text);
    expect(names.indexOf('cell 4c')).toBeLessThan(names.indexOf('left 0'));
  });

  it('finds a narrow gutter beside a wrapped figure, above full-width text', async () => {
    const { orderLines } = await import('../src/engine/columns');
    const left = Array.from({ length: 12 }, (_, i) => line(`left ${i}`, 108, 100 + 11 * i, 190));
    // A plot (tiny tick labels) and its caption, 7pt right of the text.
    const ticks = Array.from({ length: 8 }, (_, i) => line(`0.${60 - i}`, 314, 100 + 8 * i, 7, 3.2));
    const caption = Array.from({ length: 5 }, (_, i) => line(`caption ${i}`, 305, 172 + 11 * i, 200));
    const below = Array.from({ length: 4 }, (_, i) => line(`full ${i}`, 108, 232 + 11 * i, 397));
    const { ordered } = orderLines([...below, ...caption, ...ticks, ...left], 0);
    const order = ordered.map((l) => l.fragments[0].text).filter((t) => !t.startsWith('0.'));
    expect(order).toEqual([...left, ...caption, ...below].map((l) => l.fragments[0].text));
  });
});

describe('tables without rules', () => {
  // One line whose words sit at the given x positions (5pt per character).
  const line = (words: [string, number][], baseline: number) => {
    const chars: { x: number; y: number; w: number; h: number }[] = [];
    let text = '';
    words.forEach(([word, x], i) => {
      if (i) {
        const gapStart = chars[chars.length - 1].x + 5;
        chars.push({ x: gapStart, y: baseline - 8, w: x - gapStart, h: 10 });
        text += ' ';
      }
      [...word].forEach((_, k) => chars.push({ x: x + 5 * k, y: baseline - 8, w: 5, h: 10 }));
      text += word;
    });
    const x = chars[0].x;
    const width = chars[chars.length - 1].x + 5 - x;
    const fragment = { page: 0, text, x, top: baseline - 8, width, height: 10, baseline, fontSize: 10, fontName: 'f', chars };
    return { page: 0, fragments: [fragment], box: { x, y: baseline - 8, w: width, h: 10 }, baseline, fontSize: 10, fontName: 'f' };
  };
  const read = async (lines: ReturnType<typeof line>[]) => {
    const { tableChars } = await import('../src/engine/tables');
    // Booktabs rules: top, under the header (\midrule), bottom.
    const rules = [92, 105, 150].map((y) => ({ x0: 100, y0: y, x1: 380, y1: y + 0.4 }));
    return tableChars(lines, rules).map((c) => c.ch).join('');
  };

  it('reads rows under a centred label column and a close-set header', async () => {
    // Column names closer together than the value columns' gaps, and centred
    // row labels of different widths.
    const header = line([['ISEAR', 248], ['RT-Polarity', 283], ['FEVER', 348]], 100);
    const rows = [
      ['Random (N=500)', '0.629', '0.882', '0.679'],
      ['Margin Sampling (N=500)', '0.656', '0.895', '0.698'],
      ['Query by Committee (N=500)', '0.644', '0.887', '0.693'],
    ];
    // Each label and value is its own line, as split at wide gaps.
    const labels = rows.map(([label], i) => line([[label, 175 - (label.length * 5) / 2]], 114 + 13 * i));
    const values = rows.flatMap(([, ...v], i) => v.map((value, k) => line([[value, 250 + 50 * k]], 114 + 13 * i)));
    const text = await read([header, ...labels, ...values]);
    expect(text).toContain('ISEAR, RT-Polarity, FEVER.');
    expect(text).toContain('Random (N=500): ISEAR, 0.629; RT-Polarity, 0.882; FEVER, 0.679.');
    expect(text).toContain('Query by Committee (N=500): ISEAR, 0.644; RT-Polarity, 0.887; FEVER, 0.693.');
  });
});

describe('page layout edge cases', () => {
  const line = (text: string, x: number, y: number, w: number, fontSize = 10) => {
    const fragment = { page: 0, text, x, top: y, width: w, height: fontSize, baseline: y + 0.8 * fontSize, fontSize, fontName: 'f', chars: [] };
    return { page: 0, fragments: [fragment], box: { x, y, w, h: fontSize }, baseline: y + 0.8 * fontSize, fontSize, fontName: 'f' };
  };

  it('gives lines their full height when the font reports half of it', async () => {
    // 2501.15953: ascent 0.5 and no descent made every line half as tall, so
    // the gaps between lines looked like paragraph breaks and hid the gutter.
    const page = {
      getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
      getTextContent: async () => ({
        items: [{ str: 'state changes, enabling reconstruction', transform: [9, 0, 0, 9, 54, 346.5], width: 160, fontName: 'f1' }],
        styles: { f1: { fontFamily: 'serif', ascent: 0.5, descent: 0 } },
      }),
    };
    const { fragments } = await extractPage(page, 0);
    expect(fragments[0].height).toBeCloseTo(9);
    expect(fragments[0].baseline - fragments[0].top).toBeCloseTo(7.2);
  });

  it('reads an author block row by row, not split into the columns below it', async () => {
    // osdi18-hsieh: centred rows of 12pt names whose gaps line up with the
    // gutter between the two 10pt text columns.
    const { orderLines } = await import('../src/engine/columns');
    const authors = [
      [line('Kevin Hsieh', 88, 103, 64, 12), line('Ganesh Ananthanarayanan', 164, 103, 133, 12), line('Peter Bodik', 309, 103, 61, 12), line('Shivaram Venkataraman', 383, 103, 129, 12)],
      [line('Paramvir Bahl', 126, 121, 74, 12), line('Matthai Philipose', 212, 121, 89, 12), line('Phillip B. Gibbons', 313, 121, 94, 12), line('Onur Mutlu', 420, 121, 66, 12)],
    ];
    const left = Array.from({ length: 20 }, (_, i) => line(`left ${i}`, 72, 170 + 12 * i, 225));
    const right = Array.from({ length: 20 }, (_, i) => line(`right ${i}`, 315, 170 + 12 * i, 225));
    const { ordered } = orderLines([...right, ...left, ...authors.flat()], 0, 10);
    expect(ordered.map((l) => l.fragments[0].text)).toEqual([...authors.flat(), ...left, ...right].map((l) => l.fragments[0].text));
  });

  it('drops text beyond the running header, but not text above a figure’s repeated axis label', async () => {
    const { findMarginLines } = await import('../src/engine/margins');
    const pages = [0, 1, 2].map((page) => {
      const header = { ...line('Online Cascade Learning for Efficient Inference', 180, 48, 236, 9), page };
      const tick = { ...line('1.00', 65, 65, 14, 7), page }; // a figure at the top of every page
      const body = { ...line(['Video analytics is costly.', 'Cascades cut the cost.', 'Results follow below.'][page], 317, 58, 239), page };
      const hidden = { ...line('Online Model Cascade', 97, 8, 179, 16), page };
      return { page, height: 792, lines: page === 1 ? [header, tick, body, hidden] : [header, tick, body] };
    });
    const dropped = findMarginLines(pages);
    const text = (l: { fragments: { text: string }[] }) => l.fragments[0].text;
    const kept = pages.flatMap((p) => p.lines.filter((l) => !dropped.has(l)).map(text));
    expect(kept).toEqual(['Video analytics is costly.', 'Cascades cut the cost.', 'Results follow below.']);
  });
});

describe('hidden text', () => {
  const run = (text: string, x: number, baseline: number, fontSize: number, fontName = 'body') => ({
    page: 0, text, x, top: baseline - 0.8 * fontSize, width: text.length * 0.5 * fontSize, height: fontSize, baseline, fontSize, fontName,
    chars: [...text].map((_, i) => ({ x: x + 0.5 * fontSize * i, y: baseline - 0.8 * fontSize, w: 0.5 * fontSize, h: fontSize })),
  });
  const body = Array.from({ length: 12 }, (_, i) => run('Recently, vision-language models have achieved remarkable progress', 62, 300 + 10.5 * i, 8.4));

  it('drops a shifted copy of a figure lying on the body text, and keeps the figure', async () => {
    const { dropHiddenText } = await import('../src/engine/hidden');
    // 2504.10320 Figure 1: its labels again, shifted onto the column below.
    const labels = ['A pedestrian is observed', 'action that deviates from', 'p r e v i o u s l y', 'p e d e s t r i a n', 'Interpretable Reasoning', 'Normal&Abnomral'];
    const figure = labels.map((t, i) => run(t, 139, 140 + 6 * i, 4.5, 'fig'));
    const copy = labels.map((t, i) => run(t, 139 + 10, 140 + 6 * i + 160, 4.5, 'fig'));
    const kept = dropHiddenText([...body, ...figure, ...copy]);
    expect(kept).toEqual([...body, ...figure]);
  });

  it('keeps repeated subplot labels that lie on nothing', async () => {
    const { dropHiddenText } = await import('../src/engine/hidden');
    const labels = ['Accuracy (%)', 'Budget', '0.70', '0.75', '0.80', 'IMDB'];
    const plots = [0, 120, 240, 360].flatMap((dx) => labels.map((t, i) => run(t, 60 + dx, 80 + 8 * i, 5, 'fig')));
    expect(dropHiddenText([...body, ...plots])).toHaveLength(body.length + plots.length);
  });

  it('drops a long small run squeezed between two body lines, not a smaller URL on a line', async () => {
    const { dropHiddenText } = await import('../src/engine/hidden');
    const above = run('In all cases, the recall of anomalies in coarse-grained', 318, 219, 10);
    const below = run('filtering remains above 95%.', 318, 231, 10);
    const squeezed = run('prompt-switching threshold a的时候，选择red circle', 320, 223, 6.1, 'cjk');
    const url = run('https://youtube.com/watch', 418, 231, 7, 'tt');
    expect(dropHiddenText([above, below, squeezed, url])).toEqual([above, below, url]);
  });
});

describe('glyph names', () => {
  it('turn into the text they name', async () => {
    const { glyphText } = await import('../src/engine/glyphs');
    expect(glyphText('f_l')).toBe('fl');
    expect(glyphText('f_f_i')).toBe('ffi');
    expect(glyphText('f_f.alt')).toBe('ff');
    expect(glyphText('abreve')).toBe('ă');
    expect(glyphText('Scedilla')).toBe('Ş');
    expect(glyphText('uni0103')).toBe('ă');
    expect(glyphText('germandbls')).toBe('ß');
    expect(glyphText('exclam')).toBeNull();
    expect(glyphText('summationdisplay.1')).toBeNull();
  });

  it('correct characters the PDF maps wrongly, and nothing else', async () => {
    // 2504.10320: the font names code 36 "f_l" and 37 "abreve", but the PDF's
    // table maps them to "$" and "%". Codes named as punctuation stay.
    const map: string[] = [];
    for (let c = 32; c < 127; c++) map[c] = String.fromCharCode(c);
    const differences: string[] = [];
    differences[36] = 'f_l';
    differences[37] = 'abreve';
    differences[33] = 'exclam';
    const font = { differences, toUnicode: { _map: map } };
    const page = {
      getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
      getTextContent: async () => ({
        items: ['re$ective questions', 'Nicolae-C%t%lin Ristea!'].map((str, i) => ({ str, transform: [10, 0, 0, 10, 72, 700 - 12 * i], width: str.length * 5, fontName: 'f1' })),
        styles: { f1: { fontFamily: 'serif' } },
      }),
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      commonObjs: { has: (id: string) => id === 'f1', get: () => font },
    };
    const { fragments } = await extractPage(page, 0, undefined, { save: 1, restore: 2, transform: 3, constructPath: 4, stroke: 5, closeStroke: 6, fill: 7, eoFill: 8, fillStroke: 9, eoFillStroke: 10, closeFillStroke: 11, closeEOFillStroke: 12 });
    expect(fragments.map((f) => f.text)).toEqual(['reflective questions', 'Nicolae-Cătălin Ristea!']);
    expect(fragments[0].chars).toHaveLength('reflective questions'.length);
  });
});

describe('maths letters', () => {
  const ops = { save: 1, restore: 2, transform: 3, constructPath: 4, stroke: 5, closeStroke: 6, fill: 7, eoFill: 8, fillStroke: 9, eoFillStroke: 10, closeFillStroke: 11, closeEOFillStroke: 12 };
  // A maths font whose table assigns 𝐴, 𝐵, 𝐶… to codes in order (2504.10320,
  // LibertineMathMI), while its glyph names say what each glyph is.
  const blindFont = (names: Record<number, string>) => {
    const map: string[] = [];
    for (let c = 0; c < 26; c++) map[22 + c] = String.fromCodePoint(0x1d434 + c);
    const differences: string[] = [];
    for (const [code, name] of Object.entries(names)) differences[Number(code)] = name;
    return { differences, toUnicode: { _map: map } };
  };
  const pageWith = (str: string, font: object) => ({
    getViewport: () => ({ width: 612, height: 792, transform: [1, 0, 0, -1, 0, 792] }),
    getTextContent: async () => ({ items: [{ str, transform: [10, 0, 0, 10, 72, 700], width: 60, fontName: 'm' }], styles: { m: { fontFamily: 'serif' } } }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    commonObjs: { has: () => true, get: () => font },
  });

  it('are read from glyph names when the table disagrees with them throughout', async () => {
    // Codes 40, 50, 41, 26 are 𝑆, 𝑐… by the table but 𝑖, 𝑘, 𝑁, 𝑙 by name.
    const font = blindFont({ 40: 'u1D456', 41: 'u1D441', 26: 'u1D459', 32: 'u1D458' });
    const str = String.fromCodePoint(0x1d434 + 18, 0x1d434 + 19, 0x1d434 + 4); // 𝑆𝑇𝐸: codes 40, 41, 26
    const { fragments } = await extractPage(pageWith(str, font), 0, undefined, ops);
    expect(fragments[0].text).toBe('𝑖𝑁𝑙');
  });

  it('are left alone when only one or two glyphs disagree', async () => {
    const font = blindFont({ 40: 'u1D456', 41: 'u1D441' });
    const str = String.fromCodePoint(0x1d434 + 18);
    const { fragments } = await extractPage(pageWith(str, font), 0, undefined, ops);
    expect(fragments[0].text).toBe(str);
  });

  it('are spoken as plain letters, symbols apart and subscript words whole', async () => {
    const { buildUnits } = await import('../src/engine/units');
    // Each part: text and glyph height (a symbol at 10, its subscript at 7).
    const line = (parts: [string, number][], baseline: number) => {
      const text = parts.map(([t]) => t).join('');
      // One box per UTF-16 unit: a maths letter is two.
      const chars = parts.flatMap(([t, h]) => Array.from({ length: t.length }, () => ({ x: 0, y: baseline - h, w: 5, h })));
      chars.forEach((c, i) => (c.x = 50 + 5 * i));
      const fragment = { page: 0, text, x: 50, top: baseline - 10, width: chars.length * 5, height: 10, baseline, fontSize: 10, fontName: 'f', chars };
      return { page: 0, fragments: [fragment], box: { x: 50, y: baseline - 10, w: chars.length * 5, h: 10 }, baseline, fontSize: 10, fontName: 'f', block: 0 };
    };
    const page = {
      page: 0, width: 612, height: 792, dropped: [], rules: [],
      blocks: [{ page: 0, order: 0, kind: 'full' as const, box: { x: 50, y: 0, w: 500, h: 792 } }],
      lines: [line([['the scores ', 10], ['𝑆', 10], ['𝑓 𝑎𝑠𝑡', 7], [' and the pattern ', 10], ['𝑁', 10], ['𝑖𝑘', 7], [' for the ', 10], ['𝑖', 10], ['-th scene.', 10]], 100)],
    };
    const dictionary = { has: (w: string) => ['fast', 'scores', 'pattern', 'scene'].includes(w) };
    const [unit] = buildUnits([page], 10, DEFAULT_OPTIONS, dictionary);
    expect(unit.text).toBe('the scores S fast and the pattern N i k for the i-th scene.');
  });
});

describe('broken ligatures', () => {
  it('repairs words when the repaired form is a word, and leaves punctuation alone', async () => {
    const { buildUnits } = await import('../src/engine/units');
    const line = (text: string, baseline: number) => {
      const chars = [...text].map((_, i) => ({ x: 50 + i * 5, y: baseline - 8, w: 5, h: 10 }));
      const fragment = { page: 0, text, x: 50, top: baseline - 8, width: text.length * 5, height: 10, baseline, fontSize: 10, fontName: 'f', chars };
      return { page: 0, fragments: [fragment], box: { x: 50, y: baseline - 8, w: text.length * 5, h: 10 }, baseline, fontSize: 10, fontName: 'f', block: 0 };
    };
    const dictionary = { has: (w: string) => ['effectively', 'specific', 'first', 'efficiency', 'identifies', 'reflective', 'artificial', 'in', 'at', 'fin', 'fiat'].includes(w) };
    const page = (lines: ReturnType<typeof line>[]) => ({
      page: 0, width: 612, height: 792, dropped: [], rules: [], lines,
      blocks: [{ page: 0, order: 0, kind: 'full' as const, box: { x: 50, y: 0, w: 500, h: 792 } }],
    });
    const read = (...lines: ReturnType<typeof line>[]) => buildUnits([page(lines)], 10, DEFAULT_OPTIONS, dictionary)[0].text;
    expect(read(line('It works e!ectively in speci"c cases, the "rst time, with e#ciency.', 100))).toBe(
      'It works effectively in specific cases, the first time, with efficiency.',
    );
    expect(read(line('He said "wait" and left!', 100))).toBe('He said "wait" and left!');
    expect(read(line('Words like "in and "at stay quoted.', 100))).toBe('Words like "in and "at stay quoted.');
    // "fl" as "$"; "fi" as "!" in another font of the same paper; a name.
    expect(read(line('re$ective questions, Arti!cial Intelligence, Ca!agni et al.', 100))).toBe(
      'reflective questions, Artificial Intelligence, Caffagni et al.',
    );
    // Across a line-end hyphen too: "identi-" + '"es'.
    expect(read(line('The method identi-', 100), line('"es the anomalies.', 112))).toBe('The method identifies the anomalies.');
  });
});

describe('footnotes', () => {
  const fragment = (text: string, x: number, y: number, fontSize = 10) => ({
    page: 0, text, x, top: y, width: text.length * 0.5 * fontSize, height: fontSize, baseline: y + 0.8 * fontSize, fontSize, fontName: 'f',
    chars: [...text].map((_, i) => ({ x: x + 0.5 * fontSize * i, y, w: 0.5 * fontSize, h: fontSize })),
  });
  const body = Array.from({ length: 30 }, (_, i) =>
    fragment(['The feature of an object occurrence is generated on', 'object images cropped from ten sampled frames of it.'][i % 2], 135, 300 + 12 * i),
  );

  it('skips everything under the footnote rule, even text as large as the body', async () => {
    const { analyzeDocument } = await import('../src/engine');
    // 2403.11481: a 9pt URL footnote (more than 88% of the body size).
    const page = {
      page: 0, width: 612, height: 792,
      fragments: [...body, fragment('1https://platform.openai.com/docs/guides/embeddings', 138, 668, 9)],
      rules: [{ x0: 135, y0: 665, x1: 191, y1: 665 }],
    };
    const read = (skipFootnotes: boolean) => analyzeDocument([page], { ...DEFAULT_OPTIONS, skipFootnotes }).units.map((u) => u.text).join(' ');
    expect(read(true)).not.toContain('platform.openai.com');
    expect(read(false)).toContain('platform.openai.com');
  });

  it('does not take a fraction bar at the start of a line for the footnote rule', async () => {
    const { analyzeDocument } = await import('../src/engine');
    // 2403.10517: "180×0.02+…" over "180×0.02+…" right below the numerator.
    const page = {
      page: 0, width: 612, height: 792,
      fragments: [...body, fragment('180×0.02+8.4×0.02', 136, 670, 7), fragment('180×0.02+8.4×0.02+3', 136, 680, 7), fragment('under these conditions, the computation of CLIP features is small.', 135, 692)],
      rules: [{ x0: 135, y0: 679, x1: 200, y1: 679 }],
    };
    const text = analyzeDocument([page], { ...DEFAULT_OPTIONS, skipFootnotes: true }).units.map((u) => u.text).join(' ');
    expect(text).toContain('under these conditions, the computation of CLIP features is small.');
  });
});

describe('captions', () => {
  it('reads "Table 5." that continues a sentence as text, and a real caption as a caption', async () => {
    const { analyzeDocument } = await import('../src/engine');
    const fragment = (text: string, y: number) => ({
      page: 0, text, x: 72, top: y, width: text.length * 5, height: 10, baseline: y + 8, fontSize: 10, fontName: 'f',
      chars: [...text].map((_, i) => ({ x: 72 + 5 * i, y, w: 5, h: 10 })),
    });
    const page = {
      page: 0, width: 612, height: 792, rules: [],
      fragments: [
        fragment('Longer inputs involve more complex semantics. The average accuracy is', 200),
        fragment('notably lower on longer reviews, as evidenced in Appendix', 212),
        fragment('Table 5. Therefore, to verify our method we rearrange the data.', 224),
        fragment('The results are shown in the figure and in the table below.', 236),
        fragment('Table 6: Accuracy of the method on each of the datasets.', 280),
      ],
    };
    const units = analyzeDocument([page]).units.map((u) => [u.kind, u.text]);
    expect(units[0][0]).toBe('paragraph');
    expect(units[0][1]).toContain('as evidenced in Appendix Table 5. Therefore, to verify');
    expect(units).toContainEqual(['caption', 'Table 6: Accuracy of the method on each of the datasets.']);
  });
});

describe('tables under a caption', () => {
  it('are found when the caption’s line boxes are taller than its line spacing', async () => {
    const { analyzeDocument } = await import('../src/engine');
    // 2504.10320 Table 1: line boxes taller than the line spacing (12pt
    // boxes 10pt apart), so each caption line starts above where the one
    // before it ends.
    const run = (text: string, x: number, baseline: number, fontSize: number, height = fontSize) => ({
      page: 0, text, x, top: baseline - 0.8 * height, width: text.length * 0.5 * fontSize, height, baseline, fontSize, fontName: 'f',
      chars: [...text].map((_, i) => ({ x: x + 0.5 * fontSize * i, y: baseline - 0.8 * height, w: 0.5 * fontSize, h: height })),
    });
    const caption = ['Table 1: AUC scores of several state-of-the-art methods ver-', 'sus SlowFastVAD on Ped2 and Avenue datasets. The top three', 'methods are shown in red, green, and blue.'].map((t, i) => run(t, 62, 136 + 10 * i, 8.4, 12));
    const rows = [['Method', 'Year', 'Micro', 'Macro'], ['LSHF', '2016', '91.0', '-'], ['AnomalyGAN', '2017', '93.5', '-'], ['FuturePred', '2018', '95.4', '81.7']].flatMap((cells, r) =>
      cells.map((c, k) => run(c, 67 + 55 * k, 178 + 9.5 * r, 7.8)),
    );
    const body = ['metrics. Furthermore, in contrast to VLM-only methods, SlowFastVAD not', 'only achieves significantly faster inference, but also delivers improved', 'detection performance in all of the settings that we have studied here.'].map((t, i) => run(t, 62, 240 + 10.5 * i, 8.4));
    const page = { page: 0, width: 612, height: 792, rules: [], fragments: [...caption, ...rows, ...body] };
    const text = analyzeDocument([page]).units.map((u) => `${u.kind}: ${u.text}`);
    expect(text[0]).toMatch(/^caption: Table 1: AUC scores/);
    expect(text.join(' ')).not.toContain('AnomalyGAN');
    expect(text.join(' ')).toContain('paragraph: metrics. Furthermore');
  });
});

describe('list bullets', () => {
  it('are not read aloud', async () => {
    const { buildUnits } = await import('../src/engine/units');
    const line = (text: string, baseline: number) => {
      const chars = [...text].map((_, i) => ({ x: 50 + i * 5, y: baseline - 8, w: 5, h: 10 }));
      const fragment = { page: 0, text, x: 50, top: baseline - 8, width: text.length * 5, height: 10, baseline, fontSize: 10, fontName: 'f', chars };
      return { page: 0, fragments: [fragment], box: { x: 50, y: baseline - 8, w: text.length * 5, h: 10 }, baseline, fontSize: 10, fontName: 'f', block: 0 };
    };
    const read = (text: string) => {
      const page = {
        page: 0, width: 612, height: 792, dropped: [], rules: [], lines: [line(text, 100)],
        blocks: [{ page: 0, order: 0, kind: 'full' as const, box: { x: 50, y: 0, w: 500, h: 792 } }],
      };
      return buildUnits([page], 10, DEFAULT_OPTIONS)[0].text;
    };
    expect(read('• IMDB. Has 25,000 samples. • HateSpeech. Has 10,703 samples (1:7.95 ratio).')).toBe(
      'IMDB. Has 25,000 samples. HateSpeech. Has 10,703 samples (1:7.95 ratio).',
    );
    expect(read('Three knobs: • frame rate • image size')).toBe('Three knobs: frame rate; image size');
  });
});

describe('sentences', () => {
  it('does not split after common abbreviations or initials', () => {
    const text = 'We follow Smith et al. in this. Dr. Jones agrees with J. Doe. Done.';
    const s = splitSentences(text).map((r) => text.slice(r.start, r.end));
    expect(s).toEqual(['We follow Smith et al. in this.', 'Dr. Jones agrees with J. Doe.', 'Done.']);
  });

  it('keeps a section number with its heading', () => {
    for (const text of ['6. Related Work', '6.1. Knowledge Distillation', '1. NOSCOPE achieves higher throughput.']) {
      expect(splitSentences(text).map((r) => text.slice(r.start, r.end))).toEqual([text]);
    }
  });
});

describe('fixture is a real trap', () => {
  it('pdf.js stream order alternates between the columns', async () => {
    const doc = await getDocument({ data: buildFixturePdf(), verbosity: 0 }).promise;
    const page = await extractPage(await doc.getPage(1), 0);
    const columns = page.fragments
      .filter((f) => f.fontSize === 10 && f.width < 260) // column body lines
      .map((f) => (f.x < 300 ? 'L' : 'R'));
    const switches = columns.filter((c, i) => i > 0 && c !== columns[i - 1]).length;
    // Reading in stream order would cross the gutter on almost every line.
    expect(switches).toBeGreaterThanOrEqual(10);
  });
});
