// Speaks reading units one sentence per utterance with the Web Speech API.
//
// Short utterances keep seeking, voice and rate changes instant, and avoid
// engines that cut off long text. Pause is implemented as cancel + resume
// from the last spoken word, which behaves the same on every engine
// (speechSynthesis.pause() is unreliable with online voices).

import type { ReadingUnit } from '../engine/types';

export type ReaderState = 'idle' | 'playing' | 'paused';

export interface Position {
  unit: number;
  char: number;
}

export interface ReaderCallbacks {
  onState(state: ReaderState): void;
  onSentence(unit: number, start: number, end: number): void;
  onWord(unit: number, start: number, end: number): void;
  /** A sentence was spoken to its end: for measuring the voice's speed. */
  onSpoken?(text: string, ms: number, rate: number, voice: string): void;
}

const WORD = /[\p{L}\p{N}'’-]+/uy;

export class Reader {
  state: ReaderState = 'idle';
  private units: ReadingUnit[] = [];
  private pos: Position = { unit: 0, char: 0 };
  private generation = 0;
  private voice: SpeechSynthesisVoice | null = null;
  private rate = 1;

  constructor(
    private readonly cb: ReaderCallbacks,
    private readonly synth: SpeechSynthesis = speechSynthesis,
  ) {}

  setUnits(units: ReadingUnit[]) {
    this.stop();
    this.units = units;
    this.pos = { unit: 0, char: 0 };
  }

  setVoice(voice: SpeechSynthesisVoice | null) {
    this.voice = voice;
    this.restartIfPlaying();
  }

  setRate(rate: number) {
    this.rate = rate;
    this.restartIfPlaying();
  }

  get position(): Position {
    return { ...this.pos };
  }

  /** Go to a position without speaking (shows it highlighted). */
  moveTo(pos: Position) {
    this.stop();
    this.pos = { ...pos };
    this.announcePosition();
  }

  play(from?: Position) {
    if (from) this.pos = { ...from };
    this.setState('playing');
    this.speakCurrent();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.generation++;
    this.synth.cancel();
    this.setState('paused');
  }

  toggle() {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  stop() {
    this.generation++;
    this.synth.cancel();
    this.setState('idle');
  }

  next() {
    const unit = this.units[this.pos.unit];
    if (!unit) return;
    const following = unit.sentences.find((s) => s.start > this.pos.char);
    this.pos = following ? { unit: this.pos.unit, char: following.start } : { unit: this.pos.unit + 1, char: 0 };
    this.restartIfPlaying(true);
  }

  previous() {
    const unit = this.units[this.pos.unit];
    if (!unit) return;
    const index = unit.sentences.findIndex((s) => this.pos.char < s.end);
    const current = unit.sentences[Math.max(0, index)];
    if (current && this.pos.char > current.start + 2) {
      this.pos.char = current.start;
    } else if (index > 0) {
      this.pos.char = unit.sentences[index - 1].start;
    } else if (this.pos.unit > 0) {
      const prev = this.units[this.pos.unit - 1];
      this.pos = { unit: this.pos.unit - 1, char: prev.sentences[prev.sentences.length - 1]?.start ?? 0 };
    }
    this.restartIfPlaying(true);
  }

  private restartIfPlaying(announce = false) {
    if (this.state === 'playing') this.speakCurrent();
    else if (announce) this.announcePosition();
  }

  private announcePosition() {
    const unit = this.units[this.pos.unit];
    const sentence = unit?.sentences.find((s) => this.pos.char < s.end);
    if (!unit || !sentence) return;
    this.cb.onSentence(this.pos.unit, sentence.start, sentence.end);
    this.cb.onWord(this.pos.unit, this.pos.char, wordEnd(unit.text, this.pos.char));
  }

  private speakCurrent() {
    const generation = ++this.generation;
    this.synth.cancel();

    let unitIndex = this.pos.unit;
    let unit = this.units[unitIndex];
    let sentence = unit?.sentences.find((s) => this.pos.char < s.end);
    while (unit && !sentence) {
      unitIndex++;
      unit = this.units[unitIndex];
      sentence = unit?.sentences[0];
      this.pos = { unit: unitIndex, char: 0 };
    }
    if (!unit || !sentence) {
      this.pos = { unit: 0, char: 0 };
      this.setState('idle');
      return;
    }

    const start = Math.max(sentence.start, this.pos.char);
    const utterance = new SpeechSynthesisUtterance(unit.text.slice(start, sentence.end));
    utterance.voice = this.voice;
    utterance.lang = this.voice?.lang || document.documentElement.lang || 'en-US';
    utterance.rate = this.rate;

    const text = unit.text;
    const end = sentence.end;
    this.cb.onSentence(unitIndex, sentence.start, sentence.end);
    this.cb.onWord(unitIndex, start, wordEnd(text, start));

    utterance.onboundary = (e) => {
      if (generation !== this.generation || e.name !== 'word') return;
      const a = start + e.charIndex;
      const b = e.charLength ? a + e.charLength : wordEnd(text, a);
      this.pos = { unit: unitIndex, char: a };
      this.cb.onWord(unitIndex, a, b);
    };
    const startedAt = performance.now();
    utterance.onend = () => {
      if (generation !== this.generation) return;
      this.cb.onSpoken?.(utterance.text, performance.now() - startedAt, utterance.rate, this.voice?.name ?? '');
      this.pos = { unit: unitIndex, char: end };
      this.speakCurrent();
    };
    utterance.onerror = (e) => {
      if (generation !== this.generation || e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('speech error', e.error);
      this.setState('idle');
    };
    this.synth.speak(utterance);
  }

  private setState(state: ReaderState) {
    this.state = state;
    this.cb.onState(state);
  }
}

function wordEnd(text: string, start: number): number {
  WORD.lastIndex = start;
  const m = WORD.exec(text);
  return m ? start + m[0].length : Math.min(text.length, start + 1);
}
