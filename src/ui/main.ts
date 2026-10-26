import './style.css';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  analyzeDocument,
  approximateWidths,
  canvasWidths,
  extractPage,
  keySentences,
  pagesOf,
  parseDictionary,
  sectionsOf,
  type AnalyzeOptions,
  type Dictionary,
  type DocumentAnalysis,
  type PageText,
  type Rect,
  type Section,
} from '../engine';
import { SpeakingSpeed, countWords, formatDuration, wordsLeft } from '../speech/estimate';
import { Reader, type ReaderState } from '../speech/reader';
import { hitTest, rectsFor } from './highlight';
import { holdOtherAudio } from './media';
import { saveSession, takeSession } from './session';
import { watchForUpdates, type UpdateWatch } from './updates';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const pagesEl = $('pages');
const transcriptEl = $('transcript');
const statusEl = $('status');
const docTitleEl = $('doc-title');
/** Pages in the open PDF while the status shows it (0: another message is shown). */
let readyPages = 0;
const playBtn = $<HTMLButtonElement>('play');
const voiceSelect = $<HTMLSelectElement>('voice');
const rateInput = $<HTMLInputElement>('rate');

interface PageView {
  root: HTMLDivElement;
  overlay: HTMLDivElement;
  /** CSS pixels per PDF point. */
  scale: number;
  /** Page width in PDF points. */
  width: number;
  /** The scale the canvas was last drawn at (null: not drawn yet). */
  paintedScale: number | null;
  setScale(scale: number): void;
  paint(): Promise<void>;
}

let pageTexts: PageText[] = [];
let dictionary: Dictionary | null = null;

// Loaded in the background at start-up; documents opened before it arrives
// wait for it. Without it, line-end hyphens fall back to document evidence.
const dictionaryReady = fetch(`${import.meta.env.BASE_URL}dictionary.txt`)
  .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
  .then((text) => {
    dictionary = parseDictionary(text);
  })
  .catch((err) => console.warn('dictionary unavailable, hyphen decisions use the document only', err));
let analysis: DocumentAnalysis | null = null;
let views: PageView[] = [];
let renderToken = 0;
/** The open PDF's bytes (pdf.js takes over the buffer it is given). */
let openFile: { name: string; data: Uint8Array } | null = null;

const reader = new Reader({
  onState: (state) => updatePlayButton(state),
  onSentence: (unit, start, end) => {
    showSentence(unit, start, end);
    updateReadTime();
  },
  onSpoken: (text, ms, rate, voice) => {
    speakingSpeed.measure(voice, countWords(text), ms, rate);
    updateReadTime();
  },
  onWord: (unit, start, end) => showWord(unit, start, end),
});

// ---------- loading ----------

// Text is extracted and analysed before anything is drawn, so reading can
// start immediately. Canvases are painted lazily as pages approach the
// viewport (pdf.js paints on animation frames, which browsers pause for
// hidden tabs, so painting must never block analysis).
const painter = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      painter.unobserve(entry.target);
      const view = views.find((v) => v.root === entry.target);
      view?.paint().catch((err) => console.error('page render failed', err));
    }
  },
  { root: pagesEl, rootMargin: '800px 0px' },
);

async function openDocument(data: ArrayBuffer | Uint8Array, name: string) {
  const token = ++renderToken;
  reader.stop();
  painter.disconnect();
  setStatus(`Loading ${name}…`);
  const bytes = new Uint8Array(data).slice();
  // fontExtraProperties: glyph names, to correct characters a PDF maps wrongly.
  const doc = await pdfjs.getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
  if (token !== renderToken) return;
  openFile = { name, data: bytes };
  docTitleEl.textContent = name;
  docTitleEl.title = name;
  pagesEl.replaceChildren();
  pagesEl.scrollTop = 0;
  views = [];
  pageTexts = [];
  const widths = canvasWidths() ?? approximateWidths;

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    if (token !== renderToken) return;
    const view = createPageView(page, i - 1);
    views.push(view);
    painter.observe(view.root);
    pageTexts.push(await extractPage(page, i - 1, widths, pdfjs.OPS));
    setStatus(`Analysing page ${i} of ${doc.numPages}…`);
  }
  updateZoomLabel();
  updatePageIndicator();
  await dictionaryReady;
  if (token !== renderToken) return;
  analyze();
  showReadyStatus(doc.numPages);
}

function createPageView(page: pdfjs.PDFPageProxy, index: number): PageView {
  const base = page.getViewport({ scale: 1 });
  const root = document.createElement('div');
  root.className = 'page';
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  root.append(overlay);
  pagesEl.append(root);

  let task: ReturnType<pdfjs.PDFPageProxy['render']> | null = null;
  const view: PageView = {
    root,
    overlay,
    scale: 1,
    width: base.width,
    paintedScale: null,
    // Resizing is instant: the old drawing stretches until it is redrawn.
    setScale(scale) {
      view.scale = scale;
      root.style.width = `${base.width * scale}px`;
      root.style.height = `${base.height * scale}px`;
    },
    async paint() {
      task?.cancel();
      const scale = view.scale;
      view.paintedScale = scale;
      const viewport = page.getViewport({ scale });
      // Very large zooms are drawn at a lower pixel density: one canvas of
      // hundreds of megabytes would not be drawn at all.
      const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      try {
        await task.promise;
      } catch (err) {
        if (err instanceof Error && err.name === 'RenderingCancelledException') return;
        throw err;
      }
      root.querySelector('canvas')?.remove();
      root.prepend(canvas);
    },
  };
  view.setScale(scaleFor(view));

  overlay.addEventListener('click', (e) => {
    if (!analysis) return;
    const r = overlay.getBoundingClientRect();
    const hit = hitTest(analysis.units, index, (e.clientX - r.left) / view.scale, (e.clientY - r.top) / view.scale);
    if (hit) {
      followReading(false);
      reader.play(hit);
    }
  });
  return view;
}

// ---------- reading time ----------

const readTimeEl = $('read-time');
const progressFill = $('progress-fill');
const progressEl = progressFill.parentElement!;
const progressLabel = $('progress-label');
const speakingSpeed = new SpeakingSpeed(
  (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })(),
);

const START = { unit: 0, char: 0 };

/** Reading has begun: there is a position to show and count from. */
function hasStarted() {
  const pos = reader.position;
  return reader.state !== 'idle' || pos.unit > 0 || pos.char > 0;
}

/**
 * "≈ 47 min" for the whole document before reading starts, "≈ 31 min left"
 * from the current word once it has: the words still to read (after the
 * filters) at the voice's measured speed times the Speed setting.
 */
function updateReadTime() {
  readTimeEl.hidden = !analysis;
  if (!analysis) return;
  const voice = selectedVoice()?.name ?? '';
  const rate = Number(rateInput.value) || 1;
  const started = hasStarted();
  const words = wordsLeft(analysis.units, started ? reader.position : START);
  const time = formatDuration(speakingSpeed.minutes(words, voice, rate));
  readTimeEl.textContent = started ? `≈ ${time} left` : `≈ ${time}`;
  // How far through the document, by words still to read.
  const total = wordsLeft(analysis.units, START);
  const percent = total ? Math.round((100 * (total - words)) / total) : 0;
  progressFill.style.width = `${percent}%`;
  progressLabel.textContent = `${percent}%`;
  progressEl.setAttribute('aria-valuenow', String(percent));
  const wpm = Math.round(speakingSpeed.wpm(voice) * rate);
  readTimeEl.title = `About ${words.toLocaleString()} words at ${wpm} words a minute (${voice || 'default voice'}, ${rate.toFixed(1)}×). The speed is measured as the voice reads.`;
}

// ---------- page number and number fields ----------

const pageInput = $<HTMLInputElement>('page-input');
const pageCount = $('page-count');

/**
 * A field that takes whole numbers only: anything else typed or pasted is
 * dropped as it comes in. Enter (or leaving the field) applies the number;
 * Escape, or an empty field, puts back the current value.
 */
function numberField(input: HTMLInputElement, apply: (value: number) => void, current: () => string) {
  // Digits first, then the length: a length limit on the field itself would
  // cut "1x5a0" to "1x5" before the letters are dropped.
  const maxDigits = Number(input.dataset.maxDigits) || 4;
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, maxDigits);
    if (digits !== input.value) input.value = digits;
  });
  const commit = () => {
    if (input.value === '') input.value = current();
    else apply(Number(input.value));
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      input.select();
    } else if (e.key === 'Escape') {
      input.value = current();
      input.blur();
    }
  });
  input.addEventListener('change', commit);
  // Leaving the field shows the value in use (clamped, or set by a button).
  input.addEventListener('blur', () => (input.value = current()));
  input.addEventListener('focus', () => input.select());
}

/** The page in the middle of the view (the last one once scrolled to the end). */
function visiblePage(): number {
  const view = pagesEl.getBoundingClientRect();
  if (pagesEl.scrollTop + pagesEl.clientHeight >= pagesEl.scrollHeight - 2) return views.length - 1;
  const line = view.top + 0.4 * view.height;
  const index = views.findIndex((v) => v.root.getBoundingClientRect().bottom > line);
  return index < 0 ? views.length - 1 : index;
}

const pagePrev = $<HTMLButtonElement>('page-prev');
const pageNext = $<HTMLButtonElement>('page-next');

function updatePageIndicator() {
  pageInput.disabled = views.length === 0;
  const page = views.length ? visiblePage() : 0;
  pagePrev.disabled = page <= 0;
  pageNext.disabled = page >= views.length - 1;
  pageCount.textContent = `/ ${views.length || '–'}`;
  if (document.activeElement !== pageInput) pageInput.value = views.length ? String(page + 1) : '';
}

/** Show page `number` (1-based, clamped). While reading, this is exploring. */
function goToPage(number: number) {
  if (!views.length) return;
  const index = Math.min(views.length, Math.max(1, number)) - 1;
  letGo('pages');
  const target = views[index].root.getBoundingClientRect();
  pagesEl.scrollTop += target.top - pagesEl.getBoundingClientRect().top - 8;
  pageInput.value = String(index + 1);
  updateBackButton();
}

numberField(pageInput, goToPage, () => String(visiblePage() + 1));
pagePrev.addEventListener('click', () => goToPage(visiblePage()));
pageNext.addEventListener('click', () => goToPage(visiblePage() + 2));
pageInput.addEventListener('keydown', (e) => {
  // ↑ / ↓ step a page, as in a number field.
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  goToPage(visiblePage() + 1 + (e.key === 'ArrowUp' ? 1 : -1));
  pageInput.select();
});
onScrollFrame(pagesEl, updatePageIndicator);

// ---------- zoom ----------

/** 100% is the paper's real size: 96 CSS pixels per inch, 72 PDF points. */
const POINT = 96 / 72;
const ZOOM_STEPS = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400];
const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const MAX_CANVAS_PIXELS = 16_000_000;
const zoomInput = $<HTMLInputElement>('zoom-input');
const zoomFit = $<HTMLButtonElement>('zoom-fit');

/** "fit": the page fills the width of the view; otherwise a percentage. */
let zoom: number | 'fit' = loadZoom();

function loadZoom(): number | 'fit' {
  try {
    const saved = Number(localStorage.getItem('read-aloud:zoom'));
    return saved >= MIN_ZOOM && saved <= MAX_ZOOM ? saved : 'fit';
  } catch {
    return 'fit';
  }
}

function fitScale(view: { width: number }) {
  return Math.max(0.5, Math.min(900, pagesEl.clientWidth - 32) / view.width);
}

function scaleFor(view: { width: number }) {
  return zoom === 'fit' ? fitScale(view) : (zoom / 100) * POINT;
}

/** The zoom shown: the first page's, as a percentage of real size. */
function currentPercent() {
  return (scaleFor(views[0] ?? { width: 612 }) / POINT) * 100;
}

function updateZoomLabel() {
  // Not while it is being typed in.
  if (document.activeElement !== zoomInput) zoomInput.value = String(Math.round(currentPercent()));
  zoomFit.setAttribute('aria-pressed', String(zoom === 'fit'));
}

/**
 * Change the zoom keeping the point under `anchor` (the pointer, for pinch
 * and Ctrl+wheel) in place, or else the word being read, or the middle of
 * the view.
 */
function setZoom(next: number | 'fit', anchor?: { x: number; y: number }) {
  zoom = next === 'fit' ? 'fit' : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  try {
    localStorage.setItem('read-aloud:zoom', String(zoom));
  } catch {
    // Zoom is then not remembered; nothing else depends on it.
  }
  updateZoomLabel();
  if (!views.length) return;

  const rect = pagesEl.getBoundingClientRect();
  const word = following.pages && reader.state !== 'idle' ? pagesEl.querySelector('.hl-word')?.getBoundingClientRect() : undefined;
  const at = anchor ?? (word ? { x: word.left + word.width / 2, y: word.top + word.height / 2 } : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  let fixed: { view: PageView; x: number; y: number } | null = null;
  for (const view of views) {
    const r = view.root.getBoundingClientRect();
    if (r.bottom < at.y) continue;
    fixed = { view, x: (at.x - r.left) / view.scale, y: Math.max(0, (at.y - r.top) / view.scale) };
    break;
  }

  for (const view of views) view.setScale(scaleFor(view));
  redrawHighlights();
  renderLayout();
  updatePageIndicator();
  if (fixed) {
    const r = fixed.view.root.getBoundingClientRect();
    pagesEl.scrollTop += r.top + fixed.y * fixed.view.scale - at.y;
    pagesEl.scrollLeft += r.left + fixed.x * fixed.view.scale - at.x;
  }
  scheduleRepaint();
}

function zoomStep(direction: 1 | -1) {
  const now = currentPercent();
  const next = direction > 0 ? ZOOM_STEPS.find((z) => z > now * 1.02) : [...ZOOM_STEPS].reverse().find((z) => z < now / 1.02);
  setZoom(next ?? (direction > 0 ? MAX_ZOOM : MIN_ZOOM));
}

// Pages are redrawn sharp once the zoom has settled (a pinch sends many steps).
let repaintTimer = 0;
function scheduleRepaint() {
  clearTimeout(repaintTimer);
  repaintTimer = window.setTimeout(() => {
    for (const view of views) {
      if (view.paintedScale !== null && view.paintedScale !== view.scale) painter.observe(view.root);
    }
  }, 150);
}

$('zoom-in').addEventListener('click', () => zoomStep(1));
$('zoom-out').addEventListener('click', () => zoomStep(-1));
zoomFit.addEventListener('click', () => {
  setZoom('fit');
  zoomInput.value = String(Math.round(currentPercent()));
});
numberField(zoomInput, (percent) => {
  setZoom(percent);
  zoomInput.value = String(Math.round(currentPercent()));
}, () => String(Math.round(currentPercent())));
// Pinch on a trackpad (and Ctrl+wheel) zooms the document, not the window.
pagesEl.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(currentPercent() * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
  },
  { passive: false },
);
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.key === '=' || e.key === '+') zoomStep(1);
  else if (e.key === '-' || e.key === '_') zoomStep(-1);
  else if (e.key === '0') setZoom('fit');
  else return;
  e.preventDefault();
});
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => zoom === 'fit' && setZoom('fit'), 100);
});
updateZoomLabel();

function analyze() {
  const options: AnalyzeOptions = {
    skipCitations: $<HTMLInputElement>('opt-citations').checked,
    expandAbbreviations: $<HTMLInputElement>('opt-abbrev').checked,
    skipFootnotes: !$<HTMLInputElement>('opt-footnotes').checked,
    skipCaptions: $<HTMLInputElement>('opt-captions').checked,
    skipTables: $<HTMLInputElement>('opt-tables').checked,
    readEquationText: $<HTMLInputElement>('opt-equations').checked,
  };
  analysis = analyzeDocument(pageTexts, options, dictionary);
  reader.setUnits(analysis.units);
  updateReadTime();
  // Test hook for driving the app from the browser console in development.
  if (import.meta.env.DEV) Object.assign(window, { __readAloud: { analysis, reader, views } });
  clearHighlights();
  renderTranscript();
  renderLayout();
}

// ---------- highlighting ----------

/** What is highlighted, to draw it again at a new zoom. */
const drawn: Partial<Record<'sentence' | 'word', [number, number, number]>> = {};

function redrawHighlights() {
  for (const kind of ['sentence', 'word'] as const) {
    const range = drawn[kind];
    if (range) drawRects(...range, kind);
  }
}

function clearHighlights(kind?: 'sentence' | 'word') {
  for (const k of kind ? [kind] : (['sentence', 'word'] as const)) delete drawn[k];
  const selector = kind ? `.hl-${kind}` : '.hl-sentence, .hl-word';
  for (const el of pagesEl.querySelectorAll(selector)) el.remove();
}

function drawRects(unitIndex: number, start: number, end: number, kind: 'sentence' | 'word') {
  clearHighlights(kind);
  const unit = analysis?.units[unitIndex];
  if (!unit) return [];
  drawn[kind] = [unitIndex, start, end];
  return rectsFor(unit, start, end).map((r) => placeBox(r.page, r, `hl-${kind}`, 1));
}

/** A box over page `page` at `r` (in PDF points), `pad` CSS pixels larger all round. */
function placeBox(page: number, r: Rect, className: string, pad: number) {
  const view = views[page];
  const el = document.createElement('div');
  el.className = className;
  Object.assign(el.style, {
    left: `${r.x * view.scale - pad}px`,
    top: `${r.y * view.scale - pad}px`,
    width: `${r.w * view.scale + 2 * pad}px`,
    height: `${r.h * view.scale + 2 * pad}px`,
  });
  view.overlay.append(el);
  return el;
}

function showSentence(unitIndex: number, start: number, end: number) {
  drawRects(unitIndex, start, end, 'sentence');
  markTranscript(unitIndex, start, end);
}

/** The card being read, its key sentence while it is read, and the sentence in its full text. */
function markTranscript(unitIndex: number, start: number, end: number) {
  unmarkTranscript();
  const li = transcriptEl.querySelector<HTMLLIElement>(`li[data-unit="${unitIndex}"]`);
  if (li) {
    const text = analysis!.units[unitIndex].text;
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end);
    li.classList.add('current');
    li.replaceChildren(text.slice(0, start), mark, text.slice(end));
  }
  const card = transcriptEl.querySelector<HTMLElement>(`.card[data-group="${groupOf(unitIndex)}"]`);
  card?.classList.add('current');
  for (const key of card?.querySelectorAll<HTMLElement>('li[data-key-unit]') ?? []) {
    const d = key.dataset;
    if (Number(d.keyUnit) === unitIndex && Number(d.start) < end && Number(d.end) > start) key.classList.add('current');
  }
  const target = transcriptMark();
  if (target && following.transcript) revealIn(transcriptEl, target, 'nearest', 'auto');
}

/** The summary shows nothing as being read; the full-text entry goes back to plain text. */
function unmarkTranscript() {
  for (const el of transcriptEl.querySelectorAll<HTMLElement>('.card.current, li[data-key-unit].current')) el.classList.remove('current');
  for (const li of transcriptEl.querySelectorAll<HTMLElement>('li[data-unit].current')) {
    li.classList.remove('current');
    li.textContent = analysis?.units[Number(li.dataset.unit)]?.text ?? li.textContent;
  }
}

/**
 * What to keep in view in the summary while reading: the sentence in the full
 * text if that is open, else the key sentence being read, else the card's title.
 */
function transcriptMark(): HTMLElement | null {
  const card = transcriptEl.querySelector<HTMLElement>('.card.current');
  if (!card) return null;
  return (
    card.querySelector<HTMLElement>('details[open] li.current') ??
    card.querySelector<HTMLElement>('li[data-key-unit].current') ??
    card.querySelector<HTMLElement>('.card-head')
  );
}

/** The highlighted word, or the sentence while no word is. */
function readingMark() {
  return pagesEl.querySelector<HTMLElement>('.hl-word') ?? pagesEl.querySelector<HTMLElement>('.hl-sentence');
}

function showWord(unitIndex: number, start: number, end: number) {
  const [first] = drawRects(unitIndex, start, end, 'word');
  if (first && following.pages) revealIn(pagesEl, first, 'center', 'smooth');
  updateBackButton();
}

// ---------- following the reading position ----------

// While reading, the page and the reading-order list follow the voice.
// Scrolling either one yourself frees it, so you can look around the paper
// while reading goes on; "Back to reading" / "Follow reading", clicking a
// word or a paragraph, and ⏮/⏭ follow again.
const following = { pages: true, transcript: true };
const backButton = $<HTMLButtonElement>('back-to-reading');
let lastScrolled: keyof typeof following = 'pages';
// A trackpad keeps sending wheel events for a second or two after a flick
// (momentum). Those that belong to a gesture under way when following is
// switched back on must not switch it off again: only a new gesture, after
// a pause, frees the view.
const GESTURE_GAP = 250;
let lastWheel = 0;
let ignoreGesture = false;

function letGo(which: keyof typeof following) {
  lastScrolled = which;
  if (reader.state === 'idle' || !following[which]) return;
  following[which] = false;
  updateBackButton();
}

for (const [container, which] of [
  [pagesEl, 'pages'],
  [transcriptEl, 'transcript'],
] as const) {
  container.addEventListener(
    'wheel',
    (e) => {
      const now = performance.now();
      if (now - lastWheel > GESTURE_GAP) ignoreGesture = false;
      lastWheel = now;
      if (!e.ctrlKey && !ignoreGesture) letGo(which);
    },
    { passive: true },
  );
  container.addEventListener('touchmove', () => letGo(which), { passive: true });
  // A press on the scrollbar (not on the page or the gaps between pages).
  container.addEventListener('pointerdown', (e) => {
    lastScrolled = which;
    const r = container.getBoundingClientRect();
    const onScrollbar = e.clientX >= r.left + container.clientWidth || e.clientY >= r.top + container.clientHeight;
    if (e.target === container && onScrollbar) letGo(which);
  });
  onScrollFrame(container, updateBackButton);
}

/** Runs `update` once per frame while `el` scrolls. */
function onScrollFrame(el: HTMLElement, update: () => void) {
  let queued = false;
  el.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  });
}

/** Follow the reading position again; `reveal` scrolls to it right away. */
function followReading(reveal: boolean) {
  following.pages = following.transcript = true;
  // The rest of a scroll gesture still running does not count.
  ignoreGesture = performance.now() - lastWheel < GESTURE_GAP;
  backButton.hidden = true;
  if (!reveal) return;
  const word = readingMark();
  if (word) revealIn(pagesEl, word, 'center', 'smooth');
  const mark = transcriptMark();
  if (mark) revealIn(transcriptEl, mark, 'nearest', 'smooth');
}

/**
 * Shown whenever the view is not following: "Back to reading ↓" while the
 * word being read is out of view, "Follow reading" while it is in view.
 */
function updateBackButton() {
  const word = readingMark();
  const li = transcriptMark();
  const away = (container: HTMLElement, el: HTMLElement | null) => {
    if (!el) return 0;
    const view = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.bottom < view.top ? -1 : r.top > view.bottom ? 1 : 0;
  };
  const pagesAway = following.pages ? 0 : away(pagesEl, word);
  const listAway = following.transcript ? 0 : away(transcriptEl, li);
  const direction = pagesAway || listAway;
  backButton.hidden = reader.state === 'idle' || (following.pages && following.transcript);
  if (backButton.hidden) return;
  backButton.textContent = direction ? `Back to reading ${direction < 0 ? '↑' : '↓'}` : 'Follow reading';
  // Centred at the bottom of the page view.
  const view = pagesEl.getBoundingClientRect();
  backButton.style.left = `${view.left + view.width / 2}px`;
  backButton.style.top = `${view.bottom - 56}px`;
}

backButton.addEventListener('click', () => followReading(true));
window.addEventListener('resize', updateBackButton);

/**
 * Scroll only `container` so `el` is visible. Element.scrollIntoView() would
 * also scroll every scrollable ancestor (including the window), which made
 * the view jump to the reading-order list and back at every new sentence.
 */
function revealIn(container: HTMLElement, el: HTMLElement, align: 'center' | 'nearest', behavior: ScrollBehavior) {
  const view = container.getBoundingClientRect();
  const target = el.getBoundingClientRect();
  // Zoomed in, a page can be wider than the view: bring the word into view
  // sideways too.
  if (container.scrollWidth > container.clientWidth && (target.left < view.left || target.right > view.right)) {
    container.scrollBy({ left: target.left + target.width / 2 - (view.left + view.width / 2), behavior: 'auto' });
  }
  if (container.scrollHeight <= container.clientHeight) return;
  const margin = Math.min(60, view.height / 4);
  if (target.top >= view.top + margin && target.bottom <= view.bottom - margin) return;
  const delta =
    align === 'center'
      ? target.top + target.height / 2 - (view.top + view.height / 2)
      : target.top < view.top + margin
        ? target.top - (view.top + margin)
        : target.bottom - (view.bottom - margin);
  // A far jump (reading restarted pages away) is instant: a smooth scroll
  // that every new word restarts would crawl there.
  container.scrollBy({ top: delta, behavior: Math.abs(delta) > container.clientHeight ? 'auto' : behavior });
}

// ---------- summary and layout debug ----------

// The side panel sums up the paper section by section (or page by page): a
// card per part with its key sentences, and its full text, in reading order,
// folded away under it.
type SummaryBy = 'sections' | 'pages';
const SUMMARY_BY_KEY = 'read-aloud:summary-by';
let summaryBy: SummaryBy = (() => {
  try {
    return localStorage.getItem(SUMMARY_BY_KEY) === 'pages' ? 'pages' : 'sections';
  } catch {
    return 'sections';
  }
})();
/** The parts the summary shows, one card each. */
let groups: Section[] = [];

function groupOf(unitIndex: number) {
  return groups.findIndex((g) => unitIndex >= g.first && unitIndex < g.end);
}

function readFrom(position: { unit: number; char: number }) {
  followReading(false);
  reader.play(position);
}

function renderTranscript() {
  const units = analysis!.units;
  const sections = sectionsOf(units);
  // A paper without section headings is summed up page by page.
  const hasSections = sections.length > 1;
  const by: SummaryBy = hasSections ? summaryBy : 'pages';
  groups = by === 'sections' ? sections : pagesOf(units);
  // By page, the title part and the reference list are not summed up either.
  const unsummarised = sections.filter((s) => s.kind === 'front' || s.kind === 'references');
  const keys = keySentences(units, groups, (i) => by === 'pages' && unsummarised.some((s) => i >= s.first && i < s.end));

  const cards = groups.map((group, k) => {
    const card = document.createElement('section');
    card.className = `card ${group.kind} level-${Math.min(group.level, 3)}`;
    card.dataset.group = String(k);

    const head = document.createElement('div');
    head.className = 'card-head';
    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'card-title';
    title.textContent = group.title;
    title.title = 'Read from here';
    title.addEventListener('click', () => readFrom({ unit: group.first, char: 0 }));
    const pages = document.createElement('small');
    const [from, to] = group.pages;
    pages.textContent = from === to ? `p. ${from + 1}` : `pp. ${from + 1}–${to + 1}`;
    head.append(title, pages);
    card.append(head);

    if (keys[k].length) {
      const list = document.createElement('ul');
      list.className = 'key-sentences';
      for (const key of keys[k]) {
        const li = document.createElement('li');
        Object.assign(li.dataset, { keyUnit: String(key.unit), start: String(key.start), end: String(key.end) });
        li.textContent = key.text;
        li.title = 'Click to read from this sentence';
        li.addEventListener('click', () => readFrom({ unit: key.unit, char: key.start }));
        list.append(li);
      }
      card.append(list);
    }

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const count = group.end - group.first;
    summary.textContent = `Full text · ${count} part${count === 1 ? '' : 's'}`;
    const list = document.createElement('ol');
    list.start = group.first + 1;
    for (let i = group.first; i < group.end; i++) {
      const unit = units[i];
      const li = document.createElement('li');
      li.dataset.unit = String(i);
      li.className = unit.kind;
      li.textContent = unit.text;
      li.title = `${unit.kind} · ${unit.sentences.length} sentence(s) · click to read from here`;
      li.addEventListener('click', () => readFrom({ unit: i, char: 0 }));
      list.append(li);
    }
    details.append(summary, list);
    card.append(details);
    return card;
  });

  const heading = document.createElement('h2');
  const toggle = document.createElement('span');
  toggle.className = 'segmented summary-by';
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Summarise by');
  for (const [value, label] of [
    ['sections', 'Sections'],
    ['pages', 'Pages'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(by === value));
    if (value === 'sections' && !hasSections) {
      button.disabled = true;
      button.title = 'No section headings were found in this PDF';
    }
    button.addEventListener('click', () => {
      summaryBy = value;
      try {
        localStorage.setItem(SUMMARY_BY_KEY, value);
      } catch {
        // The choice is then not remembered; nothing else depends on it.
      }
      renderTranscript();
      transcriptEl.scrollTop = 0;
    });
    toggle.append(button);
  }
  heading.append('Summary', toggle);
  transcriptEl.replaceChildren(heading, ...cards);
  // Switching between sections and pages while reading.
  if (drawn.sentence) markTranscript(...drawn.sentence);
}

function renderLayout() {
  for (const el of pagesEl.querySelectorAll('.debug')) el.remove();
  if (!analysis || !$<HTMLInputElement>('opt-layout').checked) return;
  const place = (page: number, r: Rect, cls: string, label?: string) => {
    const el = placeBox(page, r, `debug ${cls}`, 3);
    if (label) el.dataset.label = label;
  };
  for (const p of analysis.pages) {
    for (const b of p.blocks) place(p.page, b.box, `block ${b.kind}`, `${b.order + 1}`);
    for (const l of p.dropped) {
      if (l.role === 'figure' || l.role === 'table') place(p.page, l.box, 'figure-text');
      else place(p.page, l.box, 'dropped', 'skipped');
    }
    for (const l of p.lines) if (l.role === 'footnote') place(p.page, l.box, 'footnote');
  }
  analysis.units.forEach((u, i) => {
    const first = u.boxes.find((b) => b);
    if (first) place(first.page, { x: first.x, y: first.y, w: 0, h: 0 }, 'unit-start', `§${i + 1}`);
  });
}

// ---------- controls ----------

function updatePlayButton(state: ReaderState) {
  if (readyPages) showReadyStatus(readyPages);
  playBtn.dataset.state = state;
  const label = state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Play';
  playBtn.setAttribute('aria-label', label);
  playBtn.title = `${label} (Space)`;
  updateOtherAudio();
  updateReadTime();
  if (state === 'idle') {
    followReading(false);
    clearHighlights();
    unmarkTranscript();
  }
}

// ---------- settings ----------

// Speed, voice and filters are remembered in the browser as soon as they
// change (like the zoom): they survive updates, with or without a PDF open,
// and closing and reopening the app.
/** The filters that change what is read (the layout view only draws). */
const ANALYSIS_IDS = ['opt-citations', 'opt-captions', 'opt-tables', 'opt-abbrev', 'opt-footnotes', 'opt-equations'];
const FILTER_IDS = ['opt-layout', 'opt-media', ...ANALYSIS_IDS];
const SETTINGS_KEY = 'read-aloud:settings';

interface Settings {
  rate?: number;
  voice?: string;
  options?: Record<string, boolean>;
}

const savedSettings: Settings = (() => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Settings;
  } catch {
    return {};
  }
})();
/** The voice chosen by name: the browser's voice list can be rebuilt. */
let chosenVoice = savedSettings.voice ?? '';

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        rate: Number(rateInput.value),
        voice: chosenVoice,
        options: filterStates(),
      } satisfies Settings),
    );
  } catch {
    // Settings are then not remembered; nothing else depends on it.
  }
}

function filterStates() {
  return Object.fromEntries(FILTER_IDS.map((id) => [id, $<HTMLInputElement>(id).checked]));
}

function setFilterStates(states: Record<string, boolean>) {
  for (const [id, checked] of Object.entries(states)) {
    const box = document.getElementById(id);
    if (box instanceof HTMLInputElement) box.checked = checked;
  }
}

/** Show the Speed setting and give it to the reader. */
function applyRate() {
  $<HTMLOutputElement>('rate-value').textContent = `${Number(rateInput.value).toFixed(1)}×`;
  reader.setRate(Number(rateInput.value));
}

function selectedVoice(): SpeechSynthesisVoice | undefined {
  return speechSynthesis.getVoices()[Number(voiceSelect.value)];
}

function loadVoices() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  voiceSelect.replaceChildren(
    ...voices.map((v, i) => new Option(`${v.name} (${v.lang})${v.localService ? '' : ' · online'}`, String(i))),
  );
  // The chosen voice if it is installed, else a natural English one.
  const chosen = voices.findIndex((v) => v.name === chosenVoice);
  const preferred =
    chosen >= 0
      ? chosen
      : Math.max(
          0,
          voices.findIndex((v) => /^en/i.test(v.lang) && /natural|online|premium|enhanced/i.test(v.name)),
          voices.findIndex((v) => v.default),
        );
  voiceSelect.value = String(preferred);
  reader.setVoice(voices[preferred] ?? null);
}

speechSynthesis.addEventListener('voiceschanged', () => {
  loadVoices();
  updateReadTime();
});
loadVoices();
voiceSelect.addEventListener('change', () => {
  const voice = selectedVoice() ?? null;
  chosenVoice = voice?.name ?? '';
  reader.setVoice(voice);
  updateReadTime();
  saveSettings();
});
rateInput.addEventListener('input', () => {
  applyRate();
  updateReadTime();
  saveSettings();
});

/** ⏭ / ⏮ (buttons and arrow keys): the view follows the reading again. */
function stepSentence(direction: 1 | -1) {
  followReading(false);
  if (direction > 0) reader.next();
  else reader.previous();
}

playBtn.addEventListener('click', () => analysis && reader.toggle());
$('stop').addEventListener('click', () => reader.stop());
$('next').addEventListener('click', () => stepSentence(1));
$('prev').addEventListener('click', () => stepSentence(-1));
// The remembered settings, put back before any PDF is opened.
setFilterStates(savedSettings.options ?? {});
if (savedSettings.rate) {
  rateInput.value = String(savedSettings.rate);
  applyRate();
}
for (const id of FILTER_IDS) $(id).addEventListener('change', saveSettings);
for (const id of ANALYSIS_IDS) $(id).addEventListener('change', () => analysis && analyze());
$('opt-layout').addEventListener('change', renderLayout);
$('opt-media').addEventListener('change', updateOtherAudio);

/** Other audio is paused while the voice reads, and plays when it pauses or stops. */
function updateOtherAudio() {
  holdOtherAudio($<HTMLInputElement>('opt-media').checked && reader.state === 'playing');
}

for (const id of ['open', 'empty-open']) $(id).addEventListener('click', () => $<HTMLInputElement>('file').click());
$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) await openDocument(await file.arrayBuffer(), file.name).catch(showError);
});
// Filters dropdown: toggled by its button, closed by Escape or a click outside.
const filtersButton = $<HTMLButtonElement>('filters-button');
const filtersPanel = $<HTMLDivElement>('filters-panel');
const setFiltersOpen = (open: boolean) => {
  filtersPanel.hidden = !open;
  filtersButton.setAttribute('aria-expanded', String(open));
  if (open) placeFiltersPanel();
};

/**
 * Keep the dropdown on screen: it opens under its button, but moves left when
 * the button sits near the right edge (a wrapped toolbar), and scrolls inside
 * itself when the window is too short.
 */
function placeFiltersPanel() {
  const margin = 8;
  Object.assign(filtersPanel.style, { left: '0px', top: '', bottom: '', maxHeight: '' });
  const r = filtersPanel.getBoundingClientRect();
  const overflow = r.right - (window.innerWidth - margin);
  if (overflow > 0) filtersPanel.style.left = `${-Math.min(overflow, r.left - margin)}px`;
  // Below the button if it fits (or if there is more room below), else above.
  const button = filtersButton.getBoundingClientRect();
  const below = window.innerHeight - r.top - margin;
  const above = button.top - 6 - margin;
  if (r.height > below && above > below) {
    Object.assign(filtersPanel.style, { top: 'auto', bottom: 'calc(100% + 6px)', maxHeight: `${above}px` });
  } else {
    filtersPanel.style.maxHeight = `${below}px`;
  }
}
window.addEventListener('resize', () => !filtersPanel.hidden && placeFiltersPanel());
filtersButton.addEventListener('click', () => setFiltersOpen(filtersPanel.hidden !== false));
// A click outside only closes the dropdown; it does not also start reading
// at the word under it (captured before the page's own click handlers).
document.addEventListener(
  'click',
  (e) => {
    if (!filtersPanel.hidden && e.target instanceof Node && !filtersButton.parentElement!.contains(e.target)) {
      setFiltersOpen(false);
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !filtersPanel.hidden) {
    setFiltersOpen(false);
    filtersButton.focus();
  }
});
// While a file is dragged over the window, the empty page shows where to drop it.
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  if (isPdf(file)) await openDocument(await file.arrayBuffer(), file.name).catch(showError);
  else setStatus(`${file.name} is not a PDF. Open or drop a .pdf file.`);
});
document.addEventListener('keydown', (e) => {
  if (!analysis || e.metaKey || e.ctrlKey || e.altKey) return;
  // Form controls keep their own keys (the speed slider uses the arrows).
  if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
  if (e.key === ' ') {
    // Also stops a focused button from being "clicked" by the same key,
    // which would undo the toggle.
    e.preventDefault();
    reader.toggle();
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    stepSentence(e.key === 'ArrowRight' ? 1 : -1);
  } else if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
    // Scrolling with the keyboard frees the view like the mouse does.
    letGo(lastScrolled);
  }
});

/** Some systems (and downloads) leave a PDF's MIME type empty; trust the name too. */
function isPdf(file: File) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

// ---------- environments and updates ----------

const versionEl = $('version');
let updateWatch: UpdateWatch | null = null;
const appVersion: string | undefined = import.meta.env.VITE_APP_VERSION;
if (import.meta.env.DEV) {
  // The testing environment, where fixes are made: told apart at a glance.
  versionEl.textContent = 'Development';
  versionEl.classList.add('dev');
  document.title += ' (development)';
} else if (appVersion) {
  versionEl.textContent = `Version ${appVersion}`;
  updateWatch = watchForUpdates(appVersion, saveCurrentSession, (reachable) => {
    versionEl.textContent = reachable ? `Version ${appVersion}` : `Version ${appVersion} · server stopped`;
    versionEl.classList.toggle('offline', !reachable);
    versionEl.title = reachable
      ? 'New versions are offered here when they are deployed.'
      : 'The stable server is not running, so new versions cannot be offered. Start it with: npm start';
  });
} else {
  versionEl.hidden = true;
}

async function saveCurrentSession() {
  if (!openFile) return;
  await saveSession({
    ...openFile,
    position: reader.position,
    options: filterStates(),
    rate: Number(rateInput.value),
    voice: selectedVoice()?.name ?? '',
    scrollTop: pagesEl.scrollTop,
    view: viewSpot() ?? undefined,
    listScrollTop: transcriptEl.scrollTop,
    started: hasStarted(),
    following: following.pages,
    savedAt: Date.now(),
  });
}

/** Where the view is: the page at its top, and how far down and right. */
function viewSpot(): { page: number; down: number; right: number } | null {
  const top = pagesEl.getBoundingClientRect().top;
  const page = views.findIndex((v) => v.root.getBoundingClientRect().bottom > top + 1);
  if (page < 0) return null;
  const r = views[page].root.getBoundingClientRect();
  const width = pagesEl.scrollWidth - pagesEl.clientWidth;
  return { page, down: Math.max(0, (top - r.top) / r.height), right: width > 0 ? pagesEl.scrollLeft / width : 0 };
}

function showSpot(spot: { page: number; down: number; right: number }) {
  const view = views[Math.min(spot.page, views.length - 1)];
  if (!view) return;
  const r = view.root.getBoundingClientRect();
  pagesEl.scrollTop += r.top - pagesEl.getBoundingClientRect().top + spot.down * r.height;
  pagesEl.scrollLeft = spot.right * (pagesEl.scrollWidth - pagesEl.clientWidth);
}

// After "Update now": reopen the PDF where it was, with the same settings.
void takeSession().then(async (session) => {
  if (!session) return;
  setFilterStates(session.options);
  rateInput.value = String(session.rate);
  rateInput.dispatchEvent(new Event('input'));
  const restoreVoice = () => {
    const index = speechSynthesis.getVoices().findIndex((v) => v.name === session.voice);
    if (index < 0) return false;
    voiceSelect.value = String(index);
    chosenVoice = session.voice;
    reader.setVoice(speechSynthesis.getVoices()[index]);
    return true;
  };
  if (!restoreVoice()) speechSynthesis.addEventListener('voiceschanged', restoreVoice, { once: true });
  try {
    await openDocument(session.data, session.name);
  } catch (err) {
    showError(err);
    return;
  }
  // The reading position (only if reading had started: else the first
  // sentence would be highlighted and the view sent to the top), with the
  // view following it or not, as it was; then the view itself, exactly
  // where it was, also when it had been scrolled away to look elsewhere.
  if (session.started ?? true) reader.moveTo(session.position);
  // After moveTo: stopping the reader switches following back on.
  following.pages = following.transcript = session.following ?? true;
  if (session.view) showSpot(session.view);
  else pagesEl.scrollTop = session.scrollTop;
  if (session.listScrollTop !== undefined) transcriptEl.scrollTop = session.listScrollTop;
  updateBackButton();
});

/** "20 pages · click any word to start there": the hint only while not reading. */
function showReadyStatus(pages: number) {
  setStatus(`${pages} page${pages === 1 ? '' : 's'}${reader.state === 'playing' ? '' : ' · click any word to start there'}`);
  readyPages = pages;
}

function setStatus(text: string) {
  readyPages = 0;
  statusEl.textContent = text;
}

function showError(err: unknown) {
  console.error(err);
  const message = err instanceof Error ? err.message : String(err);
  // The PDF worker comes from this version's files: if they were removed
  // (an old version left open while newer ones were deployed), say so.
  if (updateWatch && /fake worker|dynamically imported module|Failed to fetch/i.test(message)) {
    setStatus('This version of the app is no longer available, so it cannot open PDFs. Use "Update now" to keep reading (your place is kept).');
    void updateWatch.check();
    return;
  }
  setStatus(`Could not open the PDF: ${message}`);
}
