// Decide what a hyphen at the end of a line means.
//
// Typesetters break words at line ends ("fre-" / "quently"), but real
// compounds also break there ("two-" / "column"). In order of trust:
//  1. the document itself: "two-column" or "datacenter" written elsewhere;
//  2. an English dictionary: "frequently" is a word -> join; "general" and
//     "purpose" are words but "generalpurpose" is not -> keep the hyphen;
//  3. without a dictionary, conservative guesses (see decide()).

import type { Dictionary } from './dictionary';
import type { SpokenChar } from './text';

export type JoinDecision = 'join' | 'keep' | 'space';

const HYPHENS = new Set(['-', '‐', '­']);
const LETTER = /\p{L}/u;
const KEEP_PREFIXES = new Set(['self', 'ex', 'all', 'quasi', 'well']);
/** Word endings that are never words on their own ("-ment", "-ations"). */
const SUFFIX =
  /^(?:ing|ings|ed|ers?|est|ly|ments?|tions?|sions?|ity|ities|ances?|ences?|ness|ous|ives?|able|ible|ably|ibly|ally|ial|ated|ations?|ating|ized?|izing|ised?|ures?|ants?|ents?|ism|ists?|ular|uling|ules?|ary|ory|ery|ical|ics|ages?|ful|less|ship|wards?|ling|ian|ians|tian|ency|ancy)$/;

export class Lexicon {
  private words = new Map<string, number>();
  private compounds = new Map<string, number>();

  private continuesWord = false;

  constructor(private readonly dictionary: Dictionary | null = null) {}

  /**
   * Feed every line's text in reading order. Word halves split by a line-end
   * hyphen ("fre-" and the next line's "quently") are not counted as words.
   */
  addLine(text: string) {
    const tokens = text.match(/\p{L}+(?:-\p{L}+)*-?/gu) ?? [];
    const startsWithFragment = this.continuesWord;
    this.continuesWord = /\p{L}-$/u.test(text);
    tokens.forEach((token, i) => {
      if (token.endsWith('-') || (i === 0 && startsWithFragment)) return;
      const key = token.toLowerCase();
      const map = key.includes('-') ? this.compounds : this.words;
      map.set(key, (map.get(key) ?? 0) + 1);
    });
  }

  /** `midSentence`: the left part does not start a sentence. */
  decide(left: string, rightPart: string, midSentence = true): 'join' | 'keep' {
    const joined = (left + rightPart).toLowerCase();
    const hyphenated = `${left}-${rightPart}`.toLowerCase();
    const asWord = this.words.get(joined) ?? 0;
    const asCompound = this.compounds.get(hyphenated) ?? 0;
    if (asCompound > asWord) return 'keep';
    if (asWord > 0) return 'join';
    if (left.includes('-')) return 'keep'; // "state-of-the-" + "art"
    if (KEEP_PREFIXES.has(left.toLowerCase())) return 'keep';
    if (/^\p{Lu}{2,}$/u.test(left)) return 'keep'; // acronym: "GPU-" + "based"

    if (this.dictionary) {
      if (this.dictionary.has(joined)) return 'join';
      // A capitalised word inside a sentence is a name: "Bren-" + "don".
      if (midSentence && /^\p{Lu}/u.test(left)) return 'join';
      const l = left.toLowerCase();
      const r = rightPart.toLowerCase();
      // Words the document uses on its own count too ("anfis" + "based").
      const known = (w: string) => this.dictionary!.has(w) || this.words.has(w);
      const twoWords = l.length >= 2 && r.length >= 3 && !SUFFIX.test(r) && known(l) && known(r);
      return twoWords ? 'keep' : 'join';
    }

    // No dictionary. A compound of two real words: "general-" + "purpose", "over-" +
    // "provisioning". Fragments fail: "fre-quently" (no word "fre"),
    // "improve-ment" (a suffix), "Chris-tian" (a name, not lower case).
    const realRight =
      rightPart.length >= 4 && !SUFFIX.test(rightPart) && (this.words.has(rightPart.toLowerCase()) || rightPart.length >= 6);
    if (/^\p{Ll}{4,}$/u.test(left) && this.words.has(left) && realRight) return 'keep';
    return 'join';
  }
}

/** How to join `next` (a new line) onto `seq` (the text so far). */
export function lineJoin(seq: SpokenChar[], next: SpokenChar[], lexicon: Lexicon): JoinDecision {
  const last = seq[seq.length - 1]?.ch;
  if (!last || !HYPHENS.has(last)) return 'space';
  const before = seq[seq.length - 2]?.ch ?? '';
  if (!LETTER.test(before)) return 'space'; // a dash, not a hyphen
  if (last === '­') return 'join';

  let i = seq.length - 2;
  while (i >= 0 && (LETTER.test(seq[i].ch) || (seq[i].ch === '-' && i > 0 && LETTER.test(seq[i - 1].ch)))) i--;
  const left = seq
    .slice(i + 1, seq.length - 1)
    .map((c) => c.ch)
    .join('');
  const rightPart = (next.map((c) => c.ch).join('').match(/^\p{L}+/u) ?? [''])[0];

  // "COVID-" + "19", "Type-" + "B": an upper-case or numeric start keeps it.
  if (!rightPart || !/^\p{Ll}/u.test(rightPart)) return 'keep';
  const preceding = seq
    .slice(Math.max(0, i - 8), i + 1)
    .map((c) => c.ch)
    .join('')
    .trimEnd();
  const midSentence = preceding.length > 0 && !/[.!?:]["'”’)\]]?$/.test(preceding);
  return lexicon.decide(left, rightPart, midSentence);
}
