// Writes a four-page, two-column "paper" PDF used by the tests.
//
// The content stream is emitted row by row across both columns (sorted by y,
// then x), the order that makes naive readers jump from side to side. It
// also contains line-end hyphenation inside a column, across the column break
// and across the page break, a real compound broken at a line end, a
// superscript footnote mark, an author line split by an affiliation mark, a
// caption inside a paragraph, a broken "Th" ligature glyph ("+e"), an
// equation number, numeric citations, abbreviations, a running header and
// page numbers; then display maths, a figure, a numbered list, references
// and three tables (plain, bordered and booktabs).
//
// Usage: node scripts/make-fixture.mjs   (writes test/fixtures/two-column.pdf)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const L = 54; // left column x
const R = 318; // right column x
const centered = (text, size) => 306 - (text.length * size * 0.45) / 2;

const header = { x: centered('Journal of Imaginary Results, Vol. 3', 8), y: 760, size: 8, text: 'Journal of Imaginary Results, Vol. 3' };

const page1 = [
  header,
  { x: centered('Column-Aware Reading Order for Spoken PDFs', 16), y: 720, size: 16, font: 'F2', text: 'Column-Aware Reading Order for Spoken PDFs' },
  // Author line split by an affiliation mark: "A. Author¹ and B. Writer".
  { x: 240, y: 698, size: 11, text: 'A. Author' },
  { x: 286, y: 702, size: 7, text: '1' },
  { x: 297, y: 698, size: 11, text: 'and B. Writer' },
  { x: L, y: 670, size: 10, text: 'Abstract. We describe a reader that speaks two-column papers in the order a person would read them and removes' },
  { x: L, y: 658, size: 10, text: 'line-end hyphens without breaking real compounds such as the phrase two-' },
  { x: L, y: 646, size: 10, text: 'column layout. Footnote markers and citation brackets are skipped so that every word is pronounced correctly.' },

  // Left column
  { x: L, y: 610, size: 12, font: 'F2', text: '1 Introduction' },
  { x: L, y: 594, size: 10, text: 'Reading aloud scientific papers is hard because' },
  { x: L, y: 582, size: 10, text: 'text is laid out in two columns and words are fre-' },
  { x: L, y: 570, size: 10, text: 'quently hyphenated at the end of a line [3]. A' },
  { x: L, y: 558, size: 10, text: 'naive reader follows the content stream order and' },
  { x: L, y: 546, size: 10, text: 'jumps between the columns.' },
  { x: L + 113, y: 550, size: 6, text: '1' },
  // Paragraph gap aligned with the right column's gap (the XY-cut trap).
  { x: L + 10, y: 522, size: 10, text: 'We group lines into columns first, as shown in' },
  { x: L, y: 510, size: 10, text: 'Fig. 2, and only then build paragraphs. Hyphen-' },
  { x: L, y: 498, size: 10, text: 'ated words such as state-of-the-art keep their' },
  { x: L, y: 486, size: 10, text: 'inner hyphens, while line-end hyphens are re-' },
  { x: L, y: 474, size: 10, text: 'moved so the voice says each word correctly' },
  // Footnote at the bottom of the left column.
  { x: L, y: 94, size: 5, text: '1' },
  { x: L + 4, y: 90, size: 8, text: 'A footnote that should be read after the body.' },

  // Right column
  { x: R, y: 610, size: 10, text: 'and the highlighted word stays on the page.' },
  { x: R, y: 586, size: 12, font: 'F2', text: '2 Method' },
  { x: R, y: 570, size: 10, text: 'Each page is cut into horizontal slabs. Slabs that' },
  { x: R, y: 558, size: 10, text: 'share a vertical gutter are merged again, which' },
  { x: R, y: 546, size: 10, text: 'avoids the classic XY-cut mistake.' },
  { x: R + 10, y: 522, size: 10, text: 'Columns are then read top to bottom, left to' },
  { x: R, y: 510, size: 10, text: 'right. Footnote markers and citation brackets' },
  { x: R, y: 498, size: 10, text: 'are skipped, and abbreviations like Eq. 4 are' },
  { x: R, y: 486, size: 10, text: 'expanded before the text is sent to the speech syn-' },

  { x: 303, y: 40, size: 10, text: '1' },
];

const page2 = [
  header,
  { x: L, y: 720, size: 10, text: 'thesizer. The result is one paragraph per reading' },
  { x: L, y: 708, size: 10, text: 'unit, with sentences spoken one at a time.' },
  { x: L, y: 684, size: 12, font: 'F2', text: '3 Results' },
  { x: L, y: 668, size: 10, text: 'The reading order was correct for all pages. We' },
  { x: L, y: 656, size: 10, text: 'used the e-mail corpus from Smith et al. and the' },
  { x: L, y: 644, size: 10, text: 'pre-processing steps [4, 7].' },
  { x: R, y: 720, size: 10, text: 'Future work will handle tables and figures that' },
  { x: R, y: 708, size: 10, text: 'span both columns of the page, because a figure' },
  // A caption placed in the middle of the paragraph it interrupts.
  { x: R, y: 688, size: 8, text: 'Figure 3: A caption placed inside the paragraph.' },
  { x: R, y: 668, size: 10, text: 'interrupts the text flow. +e same holds for tables.' },
  // Equation number in a larger font: its box top is above the equation's.
  { x: R + 60, y: 644, size: 10, text: 'x = a + b' },
  { x: R + 220, y: 644, size: 11, text: '(1)' },
  { x: 303, y: 40, size: 10, text: '2' },
];

const page3 = [
  header,
  // Section number set a quad away from its title.
  { x: L, y: 720, size: 10, font: 'F2', text: '4.2.1' },
  { x: L + 34, y: 720, size: 10, font: 'F2', text: 'Scalability' },
  // Inline stacked fraction between two pieces of one line.
  { x: L, y: 704, size: 10, text: 'The tool can support' },
  { x: 143, y: 708, size: 8, text: '5 minutes' },
  { x: 141, y: 700, size: 8, text: '34 seconds' },
  { x: 181, y: 704, size: 10, text: '= 8.8 times more jobs.' },
  // Numbered list with a hanging indent (not headings).
  { x: L, y: 680, size: 10, text: '1. Each region has sufficient storage space for the' },
  { x: L + 12, y: 668, size: 10, text: 'tables it stores (Expression 4).' },
  { x: L, y: 656, size: 10, text: '2. Short item.' },
  // Display equation inside a sentence.
  { x: L, y: 640, size: 10, text: 'The load is defined as follows:' },
  { x: L + 60, y: 622, size: 10, text: 'L = a + b (12)' },
  { x: L, y: 606, size: 10, text: 'where a is the arrival rate.' },
  // A figure (labels + caption) interrupting a sentence.
  { x: L, y: 590, size: 10, text: 'Measurements were taken every hour and' },
  { x: L + 10, y: 560, size: 7, text: '100%' },
  { x: L + 80, y: 545, size: 7, text: 'Time (hours)' },
  { x: L + 20, y: 520, size: 9, text: 'Figure 5: Load over time.' },
  { x: L, y: 500, size: 10, text: 'averaged over two weeks.' },
  // A citation list broken across two lines.
  { x: L, y: 484, size: 10, text: 'Prior systems [7, 8,' },
  { x: L, y: 472, size: 10, text: '12] read in stream order.' },
  // A table: caption above, cells on rows below.
  { x: L, y: 440, size: 9, text: 'Table 1: Results per voice.' },
  { x: L, y: 424, size: 10, text: 'Voice' },
  { x: L + 120, y: 424, size: 10, text: 'Errors' },
  { x: L, y: 412, size: 10, text: 'Samantha' },
  { x: L + 120, y: 412, size: 10, text: '3' },
  { x: L, y: 400, size: 10, text: 'Ava (online)' },
  { x: L + 120, y: 400, size: 10, text: '0' },
  { x: L, y: 376, size: 10, text: 'The online voice made no errors [3,2,1,44,55].' },

  // References with hanging indents and a URL broken across lines.
  { x: R, y: 720, size: 12, font: 'F2', text: 'References' },
  { x: R, y: 700, size: 10, text: '[1] AWS Regions, 2023.' },
  { x: R + 21, y: 688, size: 10, text: 'https://aws.amazon.com/about-' },
  { x: R + 21, y: 676, size: 10, text: 'aws/global-infrastructure/.' },
  { x: R, y: 660, size: 10, text: '[2] Kay Ousterhout and Ion Stoica. Sparrow:' },
  { x: R + 21, y: 648, size: 10, text: 'Distributed, Low Latency Scheduling. In SOSP,' },
  { x: R + 21, y: 636, size: 10, text: '2013.' },
  { x: 303, y: 40, size: 10, text: '3' },
];

// Two tables like real papers': a bordered matrix with spanning headers and
// a multi-line cell (left), and a booktabs table with wrapped text and
// vertically centred row labels (right). `rule` items are drawn lines.
const T = 9;
const page4 = [
  header,
  { x: L, y: 724, size: 12, font: 'F2', text: 'Appendix' },
  { x: L, y: 708, size: 10, text: 'Two more tables follow.' },
  { x: L, y: 700, size: 9, text: 'Table 2: Design space.' },
  // Header rows: a group title over two columns, then the column names.
  { x: 172, y: 681, size: T, text: 'Queue scope' },
  { x: 160, y: 669, size: T, text: 'Local' },
  { x: 210, y: 669, size: T, text: 'Global' },
  // Body: a row-group label spanning both rows, row labels, values.
  { x: 58, y: 656, size: T, text: 'Resource' },
  { x: 58, y: 646, size: T, text: 'scope' },
  { x: 114, y: 651, size: T, text: 'Local' },
  { x: 154, y: 656, size: T, text: '(1) Borg,' },
  { x: 154, y: 646, size: T, text: 'Hydra' },
  { x: 204, y: 651, size: T, text: '(2)' },
  { x: 114, y: 633, size: T, text: 'Global' },
  { x: 154, y: 633, size: T, text: '(3) none' },
  { x: 204, y: 633, size: T, text: '(4) Ideal' },
  ...[
    [150, 690, 250, 690], [150, 678, 250, 678], [54, 666, 250, 666], [110, 642, 250, 642], [54, 630, 250, 630],
    [150, 666, 150, 690], [250, 630, 250, 690], [200, 630, 200, 678], [54, 630, 54, 666], [110, 630, 110, 666], [150, 630, 150, 666],
  ].map((rule) => ({ rule })),
  { x: L, y: 610, size: 10, text: 'The table has headers. A grid is rebuilt from' },
  { x: L, y: 598, size: 10, text: 'the ruling lines, so a label spanning two rows' },
  { x: L, y: 586, size: 10, text: 'and a cell written on two lines are both read' },
  { x: L, y: 574, size: 10, text: 'once, in the right place.' },

  { x: R, y: 720, size: 9, text: 'Table 3: Related work.' },
  ...[[R, 712, 558, 712], [R, 697, 558, 697], [R, 640, 558, 640]].map((rule) => ({ rule })),
  { x: R, y: 702, size: T, text: 'Work' },
  { x: R + 80, y: 702, size: T, text: 'Comment' },
  { x: R, y: 683, size: T, text: 'Smith et al.' },
  { x: R + 80, y: 688, size: T, text: 'Covers columns but' },
  { x: R + 80, y: 678, size: T, text: 'ignores hyphens.' },
  { x: R, y: 656, size: T, text: 'Lee [4]' },
  { x: R + 80, y: 666, size: T, text: 'Reads tables' },
  { x: R + 80, y: 656, size: T, text: 'row by row' },
  { x: R + 80, y: 646, size: T, text: 'without headers.' },
  { x: R, y: 620, size: 10, text: 'Both tables are read with their column names.' },
  { x: R, y: 608, size: 10, text: 'Without vertical rules, columns are found from' },
  { x: R, y: 596, size: 10, text: 'the white space between them, and each wrapped' },
  { x: R, y: 584, size: 10, text: 'cell is given to the nearest row label.' },
  { x: 303, y: 40, size: 10, text: '4' },
];

export const EXPECTED_TABLES = [
  'Queue scope: Local, Global. Resource scope. Local: Local, (1) Borg, Hydra; Global, (2). Global: Local, (3) none; Global, (4) Ideal.',
  'Work, Comment. Smith et al.: Comment, Covers columns but ignores hyphens. Lee: Comment, Reads tables row by row without headers.',
];

export const EXPECTED_UNITS = [
  ['heading', 'Column-Aware Reading Order for Spoken PDFs'],
  ['paragraph', 'A. Author and B. Writer'],
  ['paragraph', 'Abstract. We describe a reader that speaks two-column papers in the order a person would read them and removes line-end hyphens without breaking real compounds such as the phrase two-column layout. Footnote markers and citation brackets are skipped so that every word is pronounced correctly.'],
  ['heading', '1 Introduction'],
  ['paragraph', 'Reading aloud scientific papers is hard because text is laid out in two columns and words are frequently hyphenated at the end of a line. A naive reader follows the content stream order and jumps between the columns.'],
  ['paragraph', 'We group lines into columns first, as shown in Figure 2, and only then build paragraphs. Hyphenated words such as state-of-the-art keep their inner hyphens, while line-end hyphens are removed so the voice says each word correctly and the highlighted word stays on the page.'],
  ['heading', '2 Method'],
  ['paragraph', 'Each page is cut into horizontal slabs. Slabs that share a vertical gutter are merged again, which avoids the classic XY-cut mistake.'],
  ['paragraph', 'Columns are then read top to bottom, left to right. Footnote markers and citation brackets are skipped, and abbreviations like Equation 4 are expanded before the text is sent to the speech synthesizer. The result is one paragraph per reading unit, with sentences spoken one at a time.'],
  ['footnote', 'A footnote that should be read after the body.'],
  ['heading', '3 Results'],
  ['paragraph', 'The reading order was correct for all pages. We used the e-mail corpus from Smith et al. and the pre-processing steps.'],
  ['paragraph', 'Future work will handle tables and figures that span both columns of the page, because a figure interrupts the text flow. The same holds for tables.'],
  ['caption', 'Figure 3: A caption placed inside the paragraph.'],
  ['equation', 'Equation 1.'],
  ['heading', '4.2.1 Scalability'],
  ['paragraph', 'The tool can support 5 minutes over 34 seconds = 8.8 times more jobs.'],
  ['paragraph', '1. Each region has sufficient storage space for the tables it stores (Expression 4).'],
  ['paragraph', '2. Short item.'],
  ['paragraph', 'The load is defined as follows: equation 12 where a is the arrival rate.'],
  ['paragraph', 'Measurements were taken every hour and averaged over two weeks.'],
  ['caption', 'Figure 5: Load over time.'],
  ['paragraph', 'Prior systems read in stream order.'],
  ['caption', 'Table 1: Results per voice.'],
  ['paragraph', 'The online voice made no errors.'],
  ['heading', 'References'],
  ['paragraph', '1. AWS Regions, 2023. link to aws.amazon.com.'],
  ['paragraph', '2. Kay Ousterhout and Ion Stoica. Sparrow: Distributed, Low Latency Scheduling. In SOSP, 2013.'],
  ['heading', 'Appendix'],
  ['paragraph', 'Two more tables follow.'],
  ['caption', 'Table 2: Design space.'],
  ['paragraph', 'The table has headers. A grid is rebuilt from the ruling lines, so a label spanning two rows and a cell written on two lines are both read once, in the right place.'],
  ['caption', 'Table 3: Related work.'],
  ['paragraph', 'Both tables are read with their column names. Without vertical rules, columns are found from the white space between them, and each wrapped cell is given to the nearest row label.'],
];

export function buildFixturePdf() {
  const pages = [page1, page2, page3, page4].map((items) =>
    [...items].filter((it) => !it.rule).sort((a, b) => b.y - a.y || a.x - b.x).map((it) => {
      const text = it.text.replace(/[\\()]/g, (c) => `\\${c}`);
      return `BT /${it.font ?? 'F1'} ${it.size} Tf 1 0 0 1 ${it.x.toFixed(2)} ${it.y} Tm (${text}) Tj ET`;
    }).concat(items.filter((it) => it.rule).map(({ rule: [x0, y0, x1, y1] }) => `0.4 w ${x0} ${y0} m ${x1} ${y1} l S`)).join('\n'),
  );

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    null, // pages, filled below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>',
  ];
  const kids = [];
  for (const body of pages) {
    objects.push(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${objects.length} 0 R >>`,
    );
    kids.push(`${objects.length} 0 R`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = objects.map((obj, i) => {
    const offset = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

// Run directly (not imported by the tests). Compared as URLs so Windows paths
// ("C:\\...") match too.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test/fixtures/two-column.pdf');
  const pdf = buildFixturePdf();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, pdf);
  console.log(`wrote test/fixtures/two-column.pdf (${pdf.length} bytes)`);
}
