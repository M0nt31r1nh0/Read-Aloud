/** A set of lower-case English words used to resolve line-end hyphens. */
export interface Dictionary {
  has(word: string): boolean;
}

/** One word per line, as written by scripts/build-dictionary.mjs. */
export function parseDictionary(text: string): Dictionary {
  return new Set(text.split('\n').filter(Boolean));
}
