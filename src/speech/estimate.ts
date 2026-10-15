// Reading time: the words still to be read, at the voice's speaking speed
// times the Speed setting. Voices differ (roughly 150-180 words a minute at
// 1.0x), so the speed starts at a typical value and is measured while the
// voice reads, then remembered per voice.

import type { ReadingUnit } from '../engine/types';
import type { Position } from './reader';

/** Words a minute at 1.0x before a voice has been measured. */
export const TYPICAL_WPM = 165;
/** How much measured speech outweighs older measurements (in words). */
const MEMORY_WORDS = 400;

// "state-of-the-art", "don't", "10,000" and "3.5" are one word each.
const WORD = /[\p{L}\p{N}]+(?:['’.,-][\p{L}\p{N}]+)*/gu;

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

/** Words from `from` to the end of the document. */
export function wordsLeft(units: ReadingUnit[], from: Position): number {
  let words = 0;
  units.forEach((unit, i) => {
    if (i > from.unit) words += countWords(unit.text);
    else if (i === from.unit) words += countWords(unit.text.slice(from.char));
  });
  return words;
}

/** "< 1 min", "47 min", "1 h 12 min". */
export function formatDuration(minutes: number): string {
  if (minutes < 1) return '< 1 min';
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Each voice's speaking speed at 1.0x, measured as it reads. */
export class SpeakingSpeed {
  private speeds: Record<string, { wpm: number; words: number }>;

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = null) {
    try {
      this.speeds = JSON.parse(storage?.getItem('read-aloud:wpm') ?? '{}');
    } catch {
      this.speeds = {};
    }
  }

  /** Words a minute at 1.0x for this voice. */
  wpm(voice: string): number {
    return this.speeds[voice]?.wpm ?? TYPICAL_WPM;
  }

  /**
   * One utterance was spoken from start to end: `words` in `ms` at `rate`.
   * Pauses between sentences count too, as they do when listening.
   */
  measure(voice: string, words: number, ms: number, rate: number) {
    if (words < 3 || ms < 300) return;
    const observed = (words / (ms / 60_000)) / rate;
    // A stall (a voice loading, a hiccup) is not the voice's speed.
    if (observed < 60 || observed > 450) return;
    const known = this.speeds[voice] ?? { wpm: observed, words: 0 };
    const weight = Math.min(known.words, MEMORY_WORDS);
    const wpm = (known.wpm * weight + observed * words) / (weight + words);
    this.speeds[voice] = { wpm, words: weight + words };
    try {
      this.storage?.setItem('read-aloud:wpm', JSON.stringify(this.speeds));
    } catch {
      // Not remembered for next time; the estimate still adapts now.
    }
  }

  /** Minutes to read `words` with this voice at `rate`. */
  minutes(words: number, voice: string, rate: number): number {
    return words / (this.wpm(voice) * rate);
  }
}
