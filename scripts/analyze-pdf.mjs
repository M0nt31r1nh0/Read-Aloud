// Shared by the inspect and audit tools: reads a PDF with pdf.js and runs the
// engine on it (loaded from the TypeScript source through Vite), with the
// full English dictionary, as the app does.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readDictionaryWords } from './dictionary-source.mjs';

/** Pages `first` to `last` (1-based, inclusive; default: all). */
export async function analyzePdf(file, first = 1, last = Infinity) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = await createServer({ root, appType: 'custom', logLevel: 'error', server: { middlewareMode: true, hmr: false } });
  try {
    const engine = await server.ssrLoadModule('/src/engine/index.ts');
    const doc = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0, fontExtraProperties: true }).promise;
    const pages = [];
    for (let i = first; i <= Math.min(last, doc.numPages); i++) pages.push(await engine.extractPage(await doc.getPage(i), i - 1, undefined, OPS));
    return engine.analyzeDocument(pages, engine.DEFAULT_OPTIONS, new Set(readDictionaryWords()));
  } finally {
    await server.close();
  }
}
