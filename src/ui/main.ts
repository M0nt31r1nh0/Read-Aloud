import './style.css';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  analyzeDocument,
  approximateWidths,
  canvasWidths,
  extractPage,
  parseDictionary,
  type AnalyzeOptions,
  type Dictionary,
  type DocumentAnalysis,
  type PageText,
} from '../engine';
import { Reader, type ReaderState } from '../speech/reader';
import { hitTest, rectsFor } from './highlight';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pagesEl = $<HTMLElement>('pages');
const transcriptEl = $<HTMLElement>('transcript');
const statusEl = $<HTMLElement>('status');
const playBtn = $<HTMLButtonElement>('play');
const voiceSelect = $<HTMLSelectElement>('voice');
const rateInput = $<HTMLInputElement>('rate');

interface PageView {
  root: HTMLDivElement;
  overlay: HTMLDivElement;
  scale: number;
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

const reader = new Reader({
  onState: (state) => updatePlayButton(state),
  onSentence: (unit, start, end) => showSentence(unit, start, end),
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
  const doc = await pdfjs.getDocument({ data }).promise;
  if (token !== renderToken) return;
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
  await dictionaryReady;
  if (token !== renderToken) return;
  analyze();
  setStatus(`${name}: ${analysis!.units.length} reading units on ${doc.numPages} page(s). Click any word to start there.`);
}

function createPageView(page: pdfjs.PDFPageProxy, index: number): PageView {
  const base = page.getViewport({ scale: 1 });
  const available = Math.min(900, pagesEl.clientWidth - 32);
  const scale = Math.max(0.5, available / base.width);
  const viewport = page.getViewport({ scale });

  const root = document.createElement('div');
  root.className = 'page';
  root.style.width = `${viewport.width}px`;
  root.style.height = `${viewport.height}px`;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  root.append(overlay);
  pagesEl.append(root);

  overlay.addEventListener('click', (e) => {
    if (!analysis) return;
    const r = overlay.getBoundingClientRect();
    const hit = hitTest(analysis.units, index, (e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
    if (hit) reader.play(hit);
  });

  const paint = async () => {
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    root.prepend(canvas);
    await page.render({
      canvas,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    }).promise;
  };
  return { root, overlay, scale, paint };
}

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
  // Test hook for driving the app from the browser console in development.
  if (import.meta.env.DEV) Object.assign(window, { __readAloud: { analysis, reader, views } });
  clearHighlights();
  renderTranscript();
  renderLayout();
}

// ---------- highlighting ----------

function clearHighlights(kind?: 'sentence' | 'word') {
  const selector = kind ? `.hl-${kind}` : '.hl-sentence, .hl-word';
  for (const el of pagesEl.querySelectorAll(selector)) el.remove();
}

function drawRects(unitIndex: number, start: number, end: number, kind: 'sentence' | 'word') {
  clearHighlights(kind);
  const unit = analysis?.units[unitIndex];
  if (!unit) return [];
  return rectsFor(unit, start, end).map((r) => {
    const view = views[r.page];
    const el = document.createElement('div');
    el.className = `hl-${kind}`;
    Object.assign(el.style, {
      left: `${r.x * view.scale - 1}px`,
      top: `${r.y * view.scale - 1}px`,
      width: `${r.w * view.scale + 2}px`,
      height: `${r.h * view.scale + 2}px`,
    });
    view.overlay.append(el);
    return el;
  });
}

function showSentence(unitIndex: number, start: number, end: number) {
  drawRects(unitIndex, start, end, 'sentence');
  for (const li of transcriptEl.querySelectorAll('li.current')) {
    li.classList.remove('current');
    li.innerHTML = escapeHtml(analysis!.units[Number((li as HTMLElement).dataset.unit)].text);
  }
  const li = transcriptEl.querySelector<HTMLLIElement>(`li[data-unit="${unitIndex}"]`);
  if (li) {
    const text = analysis!.units[unitIndex].text;
    li.classList.add('current');
    li.innerHTML = `${escapeHtml(text.slice(0, start))}<mark>${escapeHtml(text.slice(start, end))}</mark>${escapeHtml(text.slice(end))}`;
    revealIn(transcriptEl, li, 'nearest', 'auto');
  }
}

function showWord(unitIndex: number, start: number, end: number) {
  const [first] = drawRects(unitIndex, start, end, 'word');
  if (first) revealIn(pagesEl, first, 'center', 'smooth');
}

/**
 * Scroll only `container` so `el` is visible. Element.scrollIntoView() would
 * also scroll every scrollable ancestor (including the window), which made
 * the view jump to the reading-order list and back at every new sentence.
 */
function revealIn(container: HTMLElement, el: HTMLElement, align: 'center' | 'nearest', behavior: ScrollBehavior) {
  if (container.scrollHeight <= container.clientHeight) return;
  const view = container.getBoundingClientRect();
  const target = el.getBoundingClientRect();
  const margin = Math.min(60, view.height / 4);
  if (target.top >= view.top + margin && target.bottom <= view.bottom - margin) return;
  const delta =
    align === 'center'
      ? target.top + target.height / 2 - (view.top + view.height / 2)
      : target.top < view.top + margin
        ? target.top - (view.top + margin)
        : target.bottom - (view.bottom - margin);
  container.scrollBy({ top: delta, behavior });
}

// ---------- transcript and layout debug ----------

function renderTranscript() {
  const list = document.createElement('ol');
  analysis!.units.forEach((unit, i) => {
    const li = document.createElement('li');
    li.dataset.unit = String(i);
    li.className = unit.kind;
    li.textContent = unit.text;
    li.title = `${unit.kind} · ${unit.sentences.length} sentence(s) · click to read from here`;
    li.addEventListener('click', () => reader.play({ unit: i, char: 0 }));
    list.append(li);
  });
  const heading = document.createElement('h2');
  heading.textContent = 'Reading order';
  transcriptEl.replaceChildren(heading, list);
}

function renderLayout() {
  for (const el of pagesEl.querySelectorAll('.debug')) el.remove();
  if (!analysis || !$<HTMLInputElement>('opt-layout').checked) return;
  const place = (page: number, r: { x: number; y: number; w: number; h: number }, cls: string, label?: string) => {
    const view = views[page];
    const el = document.createElement('div');
    el.className = `debug ${cls}`;
    Object.assign(el.style, {
      left: `${r.x * view.scale - 3}px`,
      top: `${r.y * view.scale - 3}px`,
      width: `${r.w * view.scale + 6}px`,
      height: `${r.h * view.scale + 6}px`,
    });
    if (label) el.dataset.label = label;
    view.overlay.append(el);
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
  playBtn.textContent = state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Play';
  if (state === 'idle') {
    clearHighlights();
    for (const li of transcriptEl.querySelectorAll<HTMLElement>('li.current')) {
      li.classList.remove('current');
      li.textContent = analysis?.units[Number(li.dataset.unit)]?.text ?? li.textContent;
    }
  }
}

function loadVoices() {
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return;
  const previous = voiceSelect.value;
  voiceSelect.replaceChildren(
    ...voices.map((v, i) => new Option(`${v.name} (${v.lang})${v.localService ? '' : ' · online'}`, String(i))),
  );
  const preferred =
    voices.findIndex((v) => v.name === previous) >= 0
      ? voices.findIndex((v) => v.name === previous)
      : Math.max(
          0,
          voices.findIndex((v) => /^en/i.test(v.lang) && /natural|online|premium|enhanced/i.test(v.name)),
          voices.findIndex((v) => v.default),
        );
  voiceSelect.value = String(preferred);
  reader.setVoice(voices[preferred] ?? null);
}

speechSynthesis.addEventListener('voiceschanged', loadVoices);
loadVoices();
voiceSelect.addEventListener('change', () => reader.setVoice(speechSynthesis.getVoices()[Number(voiceSelect.value)] ?? null));
rateInput.addEventListener('input', () => {
  $<HTMLOutputElement>('rate-value').textContent = `${Number(rateInput.value).toFixed(1)}×`;
  reader.setRate(Number(rateInput.value));
});

playBtn.addEventListener('click', () => analysis && reader.toggle());
$('stop').addEventListener('click', () => reader.stop());
$('next').addEventListener('click', () => reader.next());
$('prev').addEventListener('click', () => reader.previous());
for (const id of ['opt-citations', 'opt-captions', 'opt-tables', 'opt-abbrev', 'opt-footnotes', 'opt-equations']) $(id).addEventListener('change', () => analysis && analyze());
$('opt-layout').addEventListener('change', renderLayout);

$('open').addEventListener('click', () => $<HTMLInputElement>('file').click());
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
};
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
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
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
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    reader.next();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    reader.previous();
  }
});

/** Some systems (and downloads) leave a PDF's MIME type empty; trust the name too. */
function isPdf(file: File) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function setStatus(text: string) {
  statusEl.textContent = text;
}

function showError(err: unknown) {
  console.error(err);
  setStatus(`Could not open the PDF: ${err instanceof Error ? err.message : String(err)}`);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
