import type { CharBox, ReadingUnit } from '../engine/types';

/** Merge the boxes of unit.text[start, end) into one rectangle per line. */
export function rectsFor(unit: ReadingUnit, start: number, end: number): CharBox[] {
  const rects: CharBox[] = [];
  for (const box of unit.boxes.slice(start, end)) {
    if (!box) continue;
    const last = rects[rects.length - 1];
    const sameLine =
      last &&
      last.page === box.page &&
      Math.abs(last.y - box.y) < box.h * 0.5 &&
      box.x >= last.x - 1 &&
      box.x - (last.x + last.w) < box.h * 1.5;
    if (sameLine) {
      const x1 = Math.max(last.x + last.w, box.x + box.w);
      const y1 = Math.max(last.y + last.h, box.y + box.h);
      last.y = Math.min(last.y, box.y);
      last.w = x1 - last.x;
      last.h = y1 - last.y;
    } else {
      rects.push({ ...box });
    }
  }
  return rects;
}

/** The unit and character nearest to a point on a page, within `maxDistance`. */
export function hitTest(
  units: ReadingUnit[],
  page: number,
  x: number,
  y: number,
  maxDistance = 24,
): { unit: number; char: number } | null {
  let best: { unit: number; char: number } | null = null;
  let bestDistance = maxDistance;
  units.forEach((unit, u) => {
    unit.boxes.forEach((b, i) => {
      if (!b || b.page !== page) return;
      const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
      const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
      const d = Math.hypot(dx, dy);
      if (d < bestDistance) {
        bestDistance = d;
        best = { unit: u, char: i };
      }
    });
  });
  if (!best) return null;
  // Start at the beginning of the word that was clicked.
  const hit: { unit: number; char: number } = best;
  const text = units[hit.unit].text;
  let char = hit.char;
  while (char > 0 && /[\p{L}\p{N}'’-]/u.test(text[char - 1])) char--;
  return { unit: hit.unit, char };
}
