import type { Sentence } from './types';

/** Segments ending like this are not sentence ends. */
const ABBREVIATION_END =
  /(?:\bet al|\be\.g|\bi\.e|\bFigs?|\bEqs?|\bSecs?|\bTab|\bRef|\bvs|\bcf|\bDr|\bMrs?|\bMs|\bProf|\bNo|\bapprox|\bresp|\b[A-Z])\.$/;
/** A section or list number alone ("6.", "6.1.", "A.") belongs to what follows. */
const NUMBER_ONLY = /^(?:\d{1,3}|[A-Z])(?:\.\d{1,3})*\.$/;
const MAX_SENTENCE = 400;

export function splitSentences(text: string, locale = 'en'): Sentence[] {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  const raw = [...segmenter.segment(text)].map((s) => ({ start: s.index, end: s.index + s.segment.length }));

  const merged: Sentence[] = [];
  for (const s of raw) {
    const prev = merged[merged.length - 1];
    const prevText = prev ? text.slice(prev.start, prev.end).trim() : '';
    if (prev && (ABBREVIATION_END.test(prevText) || NUMBER_ONLY.test(prevText))) prev.end = s.end;
    else merged.push({ ...s });
  }

  const out: Sentence[] = [];
  for (const s of merged) {
    for (const piece of splitLong(text, s)) {
      let { start, end } = piece;
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      if (end > start) out.push({ start, end });
    }
  }
  return out;
}

/** Very long sentences are split at ";" or "," to keep utterances short. */
function splitLong(text: string, s: Sentence): Sentence[] {
  const pieces: Sentence[] = [];
  let start = s.start;
  while (s.end - start > MAX_SENTENCE) {
    const window = text.slice(start, start + MAX_SENTENCE);
    const cut = Math.max(window.lastIndexOf('; '), window.lastIndexOf(', '));
    if (cut < MAX_SENTENCE / 4) break;
    pieces.push({ start, end: start + cut + 1 });
    start += cut + 1;
  }
  pieces.push({ start, end: s.end });
  return pieces;
}
