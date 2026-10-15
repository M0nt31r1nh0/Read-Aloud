import { describe, expect, it } from 'vitest';
import { SpeakingSpeed, TYPICAL_WPM, countWords, formatDuration, wordsLeft } from '../src/speech/estimate';
import type { ReadingUnit } from '../src/engine/types';

const unit = (text: string) => ({ text }) as ReadingUnit;

describe('reading time', () => {
  it('counts words, not punctuation or spacing', () => {
    expect(countWords('The model, trained on 10,000 frames, is state-of-the-art (see Fig. 3).')).toBe(11);
    expect(countWords('  — ; ')).toBe(0);
  });

  it('counts the words left from a position', () => {
    const units = [unit('one two three'), unit('four five six seven'), unit('eight nine')];
    expect(wordsLeft(units, { unit: 0, char: 0 })).toBe(9);
    expect(wordsLeft(units, { unit: 1, char: 'four five '.length })).toBe(4);
    expect(wordsLeft(units, { unit: 2, char: 'eight nine'.length })).toBe(0);
  });

  it('formats minutes and hours', () => {
    expect(formatDuration(0.4)).toBe('< 1 min');
    expect(formatDuration(47.2)).toBe('47 min');
    expect(formatDuration(72)).toBe('1 h 12 min');
    expect(formatDuration(120)).toBe('2 h');
  });

  it('scales with the Speed setting', () => {
    const speed = new SpeakingSpeed();
    expect(speed.minutes(TYPICAL_WPM * 10, 'Samantha', 1)).toBeCloseTo(10);
    expect(speed.minutes(TYPICAL_WPM * 10, 'Samantha', 2)).toBeCloseTo(5);
  });

  it('learns each voice’s speed as it reads, and remembers it', () => {
    const stored = new Map<string, string>();
    const storage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) };
    const speed = new SpeakingSpeed(storage);
    // Samantha reads 20 words in 6 s at 1.5x: 200 words a minute, 133 at 1.0x.
    for (let i = 0; i < 20; i++) speed.measure('Samantha', 20, 6000, 1.5);
    expect(speed.wpm('Samantha')).toBeCloseTo(133.3, 0);
    expect(speed.wpm('Daniel')).toBe(TYPICAL_WPM);
    expect(new SpeakingSpeed(storage).wpm('Samantha')).toBeCloseTo(133.3, 0);
  });

  it('ignores stalls and tiny sentences', () => {
    const speed = new SpeakingSpeed();
    speed.measure('Samantha', 20, 60_000, 1); // 20 words a minute: a stall
    speed.measure('Samantha', 2, 400, 1); // too short to tell
    expect(speed.wpm('Samantha')).toBe(TYPICAL_WPM);
  });
});
