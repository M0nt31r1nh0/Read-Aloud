// Text a PDF contains but does not show. pdf.js reports every text run,
// including runs that are clipped away or covered: a figure placed several
// times with all but one copy clipped out (2504.10320, Figure 1), or labels
// left under the body text. Such text sits on top of the text people read,
// where nothing visible can be, and is dropped before lines are built.

import type { Fragment, Rect } from './types';

/** A copy needs this many runs in common with its original. */
const MIN_COPY = 5;

export function dropHiddenText(fragments: Fragment[]): Fragment[] {
  const hidden = new Set<Fragment>();
  const coveredShare = coverage(fragments);

  // Overprinted: small text whose letters lie inside larger letters.
  for (const f of fragments) {
    if ((f.text.match(/\p{L}/gu) ?? []).length >= 3 && coveredShare.get(f)! >= 0.6) hidden.add(f);
  }

  // Squeezed in: a long run of small text between two neighbouring lines of
  // larger text (normal line spacing leaves no room for it). Sub- and
  // superscripts sit there too, but are short.
  for (const f of fragments) {
    if (f.text.trim().length < 8 || f.width < 8 * f.fontSize) continue;
    const across = (g: Fragment) => g.fontSize >= 1.2 * f.fontSize && g.x < f.x + f.width && f.x < g.x + g.width;
    // Neighbouring lines, not runs on the same line (a smaller URL in a
    // reference entry): their baselines are clearly above and below.
    const gap = (g: Fragment) => Math.abs(g.baseline - f.baseline);
    const near = (g: Fragment) => gap(g) > 0.3 * g.fontSize && gap(g) < g.fontSize;
    const above = fragments.filter((g) => across(g) && g.baseline < f.baseline && near(g));
    const below = fragments.filter((g) => across(g) && g.baseline > f.baseline && near(g));
    const neighbours = above.some((a) => below.some((b) => b.baseline - a.baseline <= 1.3 * Math.max(a.fontSize, b.fontSize)));
    if (neighbours) hidden.add(f);
  }

  // Shifted copies: the same runs (text and size) again, all moved by one
  // offset. Of the original and the copy, the one lying on top of other text
  // is the hidden one, including the parts of it that fall into white space.
  // Repeated subplots with identical labels lie on nothing and are kept.
  const byText = new Map<string, Fragment[]>();
  for (const f of fragments) {
    if (f.text.trim().length < 2) continue;
    const key = `${f.text}|${Math.round(f.fontSize * 2)}`;
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key)!.push(f);
  }
  const shifts = new Map<string, [Fragment, Fragment][]>();
  for (const same of byText.values()) {
    if (same.length < 2 || same.length > 12) continue;
    for (const a of same) {
      for (const b of same) {
        if (a === b) continue;
        const dx = Math.round(b.x - a.x);
        const dy = Math.round(b.baseline - a.baseline);
        if (Math.abs(dx) + Math.abs(dy) < 5) continue;
        const key = `${dx},${dy}`;
        if (!shifts.has(key)) shifts.set(key, []);
        shifts.get(key)!.push([a, b]);
      }
    }
  }
  const share = (group: Fragment[]) => group.filter((f) => coveredShare.get(f)! >= 0.5).length / group.length;
  for (const pairs of shifts.values()) {
    if (pairs.length < MIN_COPY) continue;
    const copy = pairs.map(([, b]) => b);
    const original = pairs.map(([a]) => a);
    if (share(copy) >= 0.25 && share(copy) > share(original) + 0.15) {
      // The whole copy, also its runs that have no twin elsewhere (single
      // letters): runs in the copy's area set in one of its fonts and sizes.
      const area = bounds(copy);
      const styles = new Set(copy.map(style));
      for (const f of fragments) if (styles.has(style(f)) && inside(f, area)) hidden.add(f);
      for (const f of copy) hidden.add(f);
    }
  }
  return hidden.size ? fragments.filter((f) => !hidden.has(f)) : fragments;
}

/**
 * For each run, the share of its letters whose centre lies inside a letter
 * of a run set at least 1.2 times larger.
 */
function coverage(fragments: Fragment[]): Map<Fragment, number> {
  const result = new Map<Fragment, number>();
  for (const f of fragments) {
    const larger = fragments.filter((g) => g.fontSize >= 1.2 * f.fontSize && overlaps(box(f), box(g)));
    if (!larger.length) {
      result.set(f, 0);
      continue;
    }
    let letters = 0;
    let covered = 0;
    [...f.text].forEach((ch, i) => {
      const c = f.chars[i];
      if (!c || /\s/.test(ch)) return;
      letters++;
      const cx = c.x + c.w / 2;
      const cy = c.y + c.h / 2;
      if (larger.some((g) => g.chars.some((r, k) => !/\s/.test(g.text[k] ?? ' ') && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h))) covered++;
    });
    result.set(f, letters ? covered / letters : 0);
  }
  return result;
}

const style = (f: Fragment) => `${f.fontName}|${Math.round(f.fontSize * 2)}`;
const box = (f: Fragment): Rect => ({ x: f.x, y: f.top, w: f.width, h: f.height });
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (f: Fragment, r: Rect) => f.x >= r.x - 1 && f.x + f.width <= r.x + r.w + 1 && f.top >= r.y - 1 && f.top + f.height <= r.y + r.h + 1;

function bounds(group: Fragment[]): Rect {
  const x0 = Math.min(...group.map((f) => f.x));
  const y0 = Math.min(...group.map((f) => f.top));
  const x1 = Math.max(...group.map((f) => f.x + f.width));
  const y1 = Math.max(...group.map((f) => f.top + f.height));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
