// Glyph names to text. A font names each of its shapes ("f_l", "abreve");
// when a PDF's character table maps a shape to the wrong character (the
// "fl" ligature to "$", "ă" to "%"), the name still says what it is.
// Names follow the Adobe Glyph List conventions: "uni0103", "u1F600",
// components joined by "_" ("f_f_i"), variants after "." ("f_f.alt"), and
// a base letter followed by its accent ("abreve", "Scedilla").

const NAMED: Record<string, string> = {
  ff: 'ff', fi: 'fi', fl: 'fl', ffi: 'ffi', ffl: 'ffl',
  dotlessi: 'ı', dotlessj: 'ȷ', germandbls: 'ß',
  ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', oslash: 'ø', Oslash: 'Ø', lslash: 'ł', Lslash: 'Ł',
  eth: 'ð', Eth: 'Ð', thorn: 'þ', Thorn: 'Þ', dcroat: 'đ', Dcroat: 'Đ', hbar: 'ħ', Hbar: 'Ħ',
  eng: 'ŋ', Eng: 'Ŋ', kgreenlandic: 'ĸ', longs: 'ſ',
};

const ACCENTS: Record<string, string> = {
  acute: '́', grave: '̀', circumflex: '̂', tilde: '̃', dieresis: '̈', ring: '̊',
  caron: '̌', breve: '̆', macron: '̄', cedilla: '̧', ogonek: '̨', dotaccent: '̇',
  hungarumlaut: '̋', commaaccent: '̦',
};
const ACCENTED = new RegExp(`^([A-Za-z]|dotlessi|dotlessj)(${Object.keys(ACCENTS).join('|')})$`);

/** The text a glyph name stands for, or null if the name says nothing. */
export function glyphText(name: string): string | null {
  const base = name.split('.')[0];
  if (!base) return null;
  if (base.includes('_')) {
    const parts = base.split('_').map(glyphText);
    return parts.every((p) => p !== null) ? parts.join('') : null;
  }
  if (/^[A-Za-z]$/.test(base)) return base;
  if (base in NAMED) return NAMED[base];
  const uni = /^uni((?:[0-9A-F]{4})+)$/.exec(base);
  if (uni) return String.fromCodePoint(...uni[1].match(/.{4}/g)!.map((h) => parseInt(h, 16)));
  const u = /^u([0-9A-F]{4,6})$/.exec(base);
  if (u) return String.fromCodePoint(parseInt(u[1], 16));
  const accented = ACCENTED.exec(base);
  if (accented) {
    const letter = accented[1].length === 1 ? accented[1] : NAMED[accented[1]];
    return (letter + ACCENTS[accented[2]]).normalize('NFC');
  }
  return null;
}
