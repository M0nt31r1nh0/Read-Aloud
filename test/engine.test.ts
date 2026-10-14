import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Lexicon, lineJoin } from '../src/engine/hyphenation';
import { splitSentences } from '../src/engine/sentences';
import { replaceAll, type SpokenChar } from '../src/engine/text';
import { CITATION_PATTERN, isCitation } from '../src/engine/units';
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

describe('sentences', () => {
  it('does not split after common abbreviations or initials', () => {
    const text = 'We follow Smith et al. in this. Dr. Jones agrees with J. Doe. Done.';
    const s = splitSentences(text).map((r) => text.slice(r.start, r.end));
    expect(s).toEqual(['We follow Smith et al. in this.', 'Dr. Jones agrees with J. Doe.', 'Done.']);
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
