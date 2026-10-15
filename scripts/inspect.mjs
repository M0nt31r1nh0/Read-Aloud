// Print the reading order the engine produces for a PDF.
// Usage: npm run inspect -- <file.pdf> [--full] [--pages 1-3]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readDictionaryWords } from './dictionary-source.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+(-\d+)?$/.test(a));
if (!file) {
  console.error('usage: npm run inspect -- <file.pdf> [--full] [--pages 1-3]');
  process.exit(1);
}
const full = args.includes('--full');
const range = args[args.indexOf('--pages') + 1]?.match(/^(\d+)(?:-(\d+))?$/);

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } });
const engine = await server.ssrLoadModule('/src/engine/index.ts');

const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0, fontExtraProperties: true }).promise;
const first = range ? Number(range[1]) : 1;
const last = range ? Number(range[2] ?? range[1]) : doc.numPages;
const pages = [];
for (let i = first; i <= Math.min(last, doc.numPages); i++) pages.push(await engine.extractPage(await doc.getPage(i), i - 1, undefined, OPS));
const analysis = engine.analyzeDocument(pages, engine.DEFAULT_OPTIONS, new Set(readDictionaryWords()));

for (const p of analysis.pages) {
  const kinds = p.blocks.map((b) => b.kind[0]).join('');
  console.log(`page ${p.page + 1}: ${p.blocks.length} blocks [${kinds}], ${p.lines.length} lines, skipped: ${p.dropped.map((l) => JSON.stringify(l.fragments.map((f) => f.text).join(''))).join(', ') || 'none'}`);
}
console.log(`body font ${analysis.bodyFontSize}pt, ${analysis.units.length} units\n`);
for (const u of analysis.units) {
  const pagesOf = [...new Set(u.boxes.filter(Boolean).map((b) => b.page + 1))].join('+');
  const text = full || u.text.length <= 160 ? u.text : `${u.text.slice(0, 110)} … ${u.text.slice(-45)}`;
  console.log(`[${String(u.id + 1).padStart(3)}] p${pagesOf} ${u.kind.padEnd(9)} ${text}`);
}
await server.close();
