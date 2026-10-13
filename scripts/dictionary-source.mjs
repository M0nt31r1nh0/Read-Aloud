// Shared by the dictionary build and the Node tools: the word-list package's
// words, lower-cased, letters only, de-duplicated and sorted.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export function readDictionaryWords() {
  const require = createRequire(import.meta.url);
  const file = path.join(path.dirname(require.resolve('word-list')), 'words.txt');
  const words = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const word = line.trim().toLowerCase();
    if (/^[a-z]+$/.test(word)) words.add(word);
  }
  return [...words].sort();
}
