import type { Section } from './sections';
import type { ReadingUnit } from './types';

/** A sentence picked to sum up its section, as it is read. */
export interface KeySentence {
  unit: number;
  start: number;
  end: number;
  text: string;
}

interface Candidate extends KeySentence {
  weights: Map<string, number>;
  /** How well placed and phrased it is for a summary (1: neutral). */
  bias: number;
}

const STOPWORDS = new Set(
  `about above across after again against all almost along also although always among and another any are around
  because been before being below between both but can cannot could did does doing done down during each either
  else even ever every few for from further had has have having her here hers him his how however into its itself
  just less like made make makes many may might more most much must near need not now off often once one only
  other others our ours out over own per same she should since some such than that the their them then there these
  they this those though through thus too two under until upon use used uses using very via was were what when
  where whether which while who whom whose why will with within without would yet you your
  figure figures table tables section sections equation shown show shows paper work`.split(/\s+/),
);

/** Openings that lean on the sentence before ("This …", "However, …"): unclear on their own. */
const LEANS_BACK =
  /^(?:this|these|that|those|it|its|they|their|such|however|thus|therefore|hence|moreover|furthermore|also|in addition|in contrast|here|then|similarly|finally|second|third|next|as a result|in response|to (?:solve|address) this)\b(?!\s+(?:paper|work|article|study)\b)/i;
/** What the authors claim: "we propose", "this paper presents", "our results show". */
const STATES_CONTRIBUTION =
  /\b(?:we|this (?:paper|work|article)|our (?:results|evaluation|experiments|analysis))\s+(?:\w+\s+)?(?:propose|present|introduce|show|find|demonstrate|achieve|design|build|develop|describe|evaluate|conclude)/i;

/** A reference-list entry outside a reference list: "[4] …", "6. C. Gao, Y. Wang, …". */
const REFERENCE_ENTRY = /^(?:\[\d+\]|\d+\.\s+(?:\p{Lu}\.\s*)+\p{Lu})/u;

function terms(text: string): string[] {
  return (text.toLowerCase().match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? []).filter((w) => w.length > 2 && !STOPWORDS.has(w)).map(stem);
}

/** Plurals and their singulars count as one word. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, w] of a) {
    na += w * w;
    dot += w * (b.get(t) ?? 0);
  }
  for (const w of b.values()) nb += w * w;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function bias(text: string, firstOfSection: boolean, firstOfParagraph: boolean): number {
  const tokens = text.split(/\s+/);
  let b = 1;
  if (firstOfSection) b *= 1.2;
  else if (firstOfParagraph) b *= 1.1;
  if (STATES_CONTRIBUTION.test(text)) b *= 1.2;
  if (LEANS_BACK.test(text)) b *= 0.7;
  if (tokens.length < 8) b *= 0.5;
  else if (tokens.length > 50) b *= 0.7;
  // Leads into a list or a display equation.
  if (/:$/.test(text)) b *= 0.6;
  // Funding notes, which can sit in the abstract's column.
  if (/\b(?:supported (?:in part )?by|under grant)\b/i.test(text)) b *= 0.3;
  // Mostly numbers: a table read as text.
  if (tokens.filter((t) => /\d/.test(t)).length > 0.3 * tokens.length) b *= 0.3;
  return b;
}

/**
 * The few sentences that best sum up each section: those whose words are
 * most typical of it, where a word counts more the more often the section
 * uses it and the fewer other sections do (TF-IDF). Openings, sentences that
 * state what the authors did, and sentences that stand on their own are
 * preferred; near-repeats of a sentence already picked are not taken.
 * Sentences are returned in reading order. Only paragraphs are summarised,
 * and nothing in the reference list, nor any unit for which `skip` returns
 * true.
 */
export function keySentences(units: ReadingUnit[], sections: Section[], skip: (unit: number) => boolean = () => false): KeySentence[][] {
  const candidates = sections.map((section) => {
    const out: Omit<Candidate, 'weights'>[] = [];
    if (section.kind === 'references') return out;
    // The title part only has an abstract run into the author lines: from "Abstract" on.
    let from = section.kind === 'front' ? abstractIn(units, section) : { unit: section.first, char: 0 };
    if (!from) return out;
    for (let i = from.unit; i < section.end; i++) {
      const unit = units[i];
      if (unit.kind !== 'paragraph' || skip(i)) continue;
      unit.sentences.forEach((s, k) => {
        if (s.end <= from!.char) return;
        const start = Math.max(s.start, from!.char);
        const text = unit.text.slice(start, s.end);
        if (REFERENCE_ENTRY.test(text) || text.split(/\s+/).length < 5) return;
        out.push({ unit: i, start, end: s.end, text, bias: bias(text, out.length === 0, k === 0) });
      });
      from = { unit: i, char: 0 };
    }
    return out;
  });

  // In how many sections each word appears.
  const termLists = candidates.map((list) => list.map((c) => terms(c.text)));
  const spread = new Map<string, number>();
  for (const lists of termLists) for (const t of new Set(lists.flat())) spread.set(t, (spread.get(t) ?? 0) + 1);
  const n = candidates.filter((list) => list.length).length;
  const weigh = (words: string[]) => {
    const w = new Map<string, number>();
    for (const t of words) w.set(t, (w.get(t) ?? 0) + Math.log(1 + n / spread.get(t)!));
    return w;
  };

  return candidates.map((list, k) => {
    const scored: Candidate[] = list.map((c, j) => ({ ...c, weights: weigh(termLists[k][j]) }));
    if (scored.length <= 2) return scored.map(plain);
    const whole = weigh(termLists[k].flat());
    const count = Math.min(3, Math.ceil(scored.length / 7));
    const ranked = scored
      .map((c) => ({ c, score: cosine(c.weights, whole) * c.bias }))
      .sort((a, b) => b.score - a.score);
    const picked: Candidate[] = [];
    for (const { c } of ranked) {
      if (picked.length === count) break;
      if (picked.some((p) => cosine(p.weights, c.weights) > 0.5)) continue;
      picked.push(c);
    }
    return picked.sort((a, b) => a.unit - b.unit || a.start - b.start).map(plain);
  });
}

/** Where an abstract starts inside the title part ("… University Abstract—We …"). */
function abstractIn(units: ReadingUnit[], section: Section): { unit: number; char: number } | null {
  for (let i = section.first; i < section.end; i++) {
    const m = /\babstract\s*[.:—–-]\s*/i.exec(units[i].text);
    if (m) return { unit: i, char: m.index + m[0].length };
  }
  return null;
}

function plain({ unit, start, end, text }: Candidate): KeySentence {
  return { unit, start, end, text };
}
