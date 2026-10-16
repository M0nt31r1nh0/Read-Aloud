// Automated quality audit of the reading units for one PDF.
// Usage: npm run audit -- <file.pdf>
//
// Flags units that look wrong: starting lower-case (a paragraph cut in two),
// not ending in punctuation, left-over running headers, odd hyphen joins,
// symbols a voice would mispronounce, highlight boxes off the page, and
// units that zig-zag back to an earlier column on the same page.
import { analyzePdf } from './analyze-pdf.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run audit -- <file.pdf>');
  process.exit(1);
}
const analysis = await analyzePdf(file);

const findings = [];
const flag = (unit, kind, detail) =>
  findings.push({ id: unit.id + 1, page: (unit.boxes.find(Boolean)?.page ?? -1) + 1, kind, detail });
const headerTexts = new Set(
  analysis.pages.flatMap((p) => p.dropped.filter((l) => l.role !== 'figure').map((l) => l.fragments.map((f) => f.text).join('').trim())),
);
const pageOf = new Map(analysis.pages.map((p) => [p.page, p]));

for (const unit of analysis.units) {
  const t = unit.text;
  if (unit.kind === 'paragraph' && /^\p{Ll}/u.test(t)) flag(unit, 'starts-lowercase', t.slice(0, 80));
  if (unit.kind === 'paragraph' && t.length > 60 && !/[.!?:;)"”’\]]$/.test(t)) flag(unit, 'no-final-punctuation', `… ${t.slice(-70)}`);
  for (const h of headerTexts) if (h.length > 8 && t.includes(h)) flag(unit, 'header-in-text', h);
  for (const m of t.matchAll(/\p{L}+-\s\p{Ll}+|\p{Ll}-\p{Ll}{1,3}\b/gu)) flag(unit, 'hyphen-join', m[0]);
  for (const m of t.matchAll(/[+§¶†‡∗*]|\s{2,}|�/gu)) flag(unit, 'odd-symbol', JSON.stringify(t.slice(Math.max(0, m.index - 20), m.index + 20)));

  let lastColumn = null;
  let last = null;
  for (const b of unit.boxes) {
    if (!b) continue;
    const p = pageOf.get(b.page);
    if (b.x < -1 || b.y < -1 || b.x + b.w > p.width + 1 || b.y + b.h > p.height + 1) {
      flag(unit, 'box-off-page', JSON.stringify(b));
      break;
    }
    const column = `${b.page}:${b.x + b.w / 2 < p.width / 2 ? 'L' : 'R'}`;
    // Going from the right half back to the left half *and up the page*.
    if (lastColumn === `${b.page}:R` && column === `${b.page}:L` && b.w > 0 && b.y < last.y - 20) {
      flag(unit, 'zig-zag', `${t.slice(0, 60)}`);
      break;
    }
    lastColumn = column;
    last = b;
  }
}

const byKind = {};
for (const f of findings) (byKind[f.kind] ??= []).push(f);
console.log(`${analysis.units.length} units, ${analysis.pages.length} pages, ${findings.length} findings`);
console.log(`dropped per page: ${analysis.pages.map((p) => p.dropped.length).join(' ')}`);
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`\n## ${kind} (${list.length})`);
  for (const f of list.slice(0, 25)) console.log(`  [${f.id}] p${f.page} ${f.detail}`);
}
