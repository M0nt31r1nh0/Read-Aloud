// Relative glyph widths, used to split a text run's known width into
// per-character boxes. Results are normalised to the run's real width, so
// only the proportions between characters matter.

/** Returns one relative width per UTF-16 code unit of `text`. */
export type CharWidths = (text: string, fontFamily: string) => number[];

const NARROW = new Set([...`iIjlft.,:;'!|\`()[]{}"- ‐`]);
const WIDE = new Set([...'mwMWQGOD@%&']);

/** Font-independent estimate; good enough when no canvas is available. */
export const approximateWidths: CharWidths = (text) => {
  const widths: number[] = [];
  for (const ch of text) {
    let w = 0.5;
    if (NARROW.has(ch)) w = 0.28;
    else if (WIDE.has(ch)) w = 0.85;
    else if (ch >= 'A' && ch <= 'Z') w = 0.68;
    widths.push(w);
    if (ch.length === 2) widths.push(0);
  }
  return widths;
};

/** Measures with a canvas in the given font family; null outside a browser. */
export function canvasWidths(): CharWidths | null {
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  if (typeof OffscreenCanvas !== 'undefined') ctx = new OffscreenCanvas(1, 1).getContext('2d');
  else if (typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  const context = ctx;
  const cache = new Map<string, number>();
  return (text, fontFamily) => {
    context.font = `100px ${fontFamily || 'sans-serif'}`;
    const widths: number[] = [];
    for (const ch of text) {
      const key = `${fontFamily}\u0000${ch}`;
      let w = cache.get(key);
      if (w === undefined) {
        w = context.measureText(ch).width;
        cache.set(key, w);
      }
      widths.push(w);
      if (ch.length === 2) widths.push(0);
    }
    return widths;
  };
}
