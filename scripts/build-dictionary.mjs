// Builds public/dictionary.txt (lower-case words, one per line) from the
// `word-list` package (MIT, based on SCOWL). The app fetches it at start-up
// to decide line-end hyphens such as "general-" + "purpose".
// Usage: node scripts/build-dictionary.mjs [--if-missing]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDictionaryWords } from './dictionary-source.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'public/dictionary.txt');

if (process.argv.includes('--if-missing') && fs.existsSync(target)) process.exit(0);
const words = readDictionaryWords();
fs.mkdirSync(path.dirname(target), { recursive: true }); // public/ is not in git
fs.writeFileSync(target, `${words.join('\n')}\n`);
console.log(`wrote public/dictionary.txt (${words.length} words, ${(fs.statSync(target).size / 1e6).toFixed(1)} MB)`);
