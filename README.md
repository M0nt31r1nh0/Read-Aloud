# PDF Read Aloud

Read PDFs aloud in your browser, with the spoken word highlighted on the page.
It is built for scientific papers, where most read-aloud tools struggle:

- **Two-column layouts** are read column by column, and paragraphs continue
  correctly across columns and pages, without jumping from side to side.
- **Hyphenated words** at line ends are rejoined ("fre-quently" → "frequently")
  while real compounds stay hyphenated ("general-purpose", "state-of-the-art").
- **Clean speech**: running headers, page numbers, citation numbers like
  `[3,2,1,44,55]`, footnote marks and the text inside figures are skipped;
  abbreviations ("Fig. 2", "§4.1", "e.g.") and URLs are read naturally.
- **Footnotes and captions** are read after the paragraph they interrupt.
- **Tables** can be read with their headers ("Cluster: Regional, (2); Global, (3).").
- **Click any word** to start reading there; the page scrolls to follow along.

Everything runs locally in the browser (pdf.js + the Web Speech API). No PDF
is uploaded anywhere.

---

## Requirements

| What | Version | Get it |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) (includes npm) | **22.13 or newer** (the 22 or 24 LTS) | nodejs.org installer, or see the commands below |
| [Git](https://git-scm.com/) | any recent | git-scm.com, or see below |
| A browser | Chrome, Edge or Safari (recent) | |

Check what you have:

```bash
node --version
npm --version
git --version
```

<details>
<summary><b>Installing Node.js and Git on Windows</b></summary>

Use the installers from [nodejs.org](https://nodejs.org/) (choose **LTS**) and
[git-scm.com](https://git-scm.com/download/win), keeping the default options,
or run this in PowerShell or Command Prompt:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Close and reopen the terminal afterwards so `node`, `npm` and `git` are found.

</details>

<details>
<summary><b>Installing Node.js and Git on macOS</b></summary>

Use the installer from [nodejs.org](https://nodejs.org/) (choose **LTS**), or
with [Homebrew](https://brew.sh/):

```bash
brew install node git
```

</details>

---

## Set up and run

The commands are the same on **Windows** (PowerShell or Command Prompt),
**macOS** and **Linux**.

```bash
git clone https://github.com/M0nt31r1nh0/Read-Aloud.git
cd Read-Aloud
npm install
npm run dev
```

Then open **http://localhost:5173** in your browser. (If that port is busy,
the terminal prints the address it used instead.) Stop the app with
<kbd>Ctrl</kbd>+<kbd>C</kbd> in the terminal.

The first `npm run dev` also builds the hyphenation dictionary
(`public/dictionary.txt`, about 3 MB); this takes a few seconds once.

---

## Two environments: stable and development

Use the **stable** app for reading. It runs the last version that passed the
tests, so it keeps working while bugs are being fixed in the **development**
app.

| | Stable | Development (testing) |
| --- | --- | --- |
| Start | `npm start` | `npm run dev` |
| Address | **http://localhost:4173** | http://localhost:5173 |
| Runs | the last deployed version | the source as it is being edited, reloading on every change |
| Label in the toolbar | `Version 20261014-140655` | `Development` (orange) |

Both can run at the same time. To publish what is in development to the
stable app:

```bash
npm run deploy
npm run deploy -- -m "Fixed table reading"   # with a note shown in the update pop-up
```

`deploy` runs the type check and all tests first. If any fail, nothing is
deployed and the stable app stays as it was. Otherwise it builds a new
version into `deploy/releases/<version>/` and switches the stable app to it.
The stable server does not need a restart.

When a new version is deployed, an open stable app shows a pop-up within
30 seconds (or as soon as you switch back to it):

- **Update now** reloads into the new version and reopens your PDF at the
  same place: the same view (page, position, zoom), the same reading
  position (also when you had scrolled away from it), and the same filters,
  speed and voice. Press Play to continue
  (browsers do not allow speech to start on its own after a reload).
- **Keep this version** closes the pop-up, and you go on with the version
  you have. The next time you open the app, it starts with the new version.

Each check offers the newest version: a pop-up still on screen is replaced,
never stacked. Versions from the last 7 days (and always the last five) are
kept, so a tab still running an older one keeps working. If a tab's version
has been removed, its pop-up says so and offers only **Update now** (your PDF
and position are still kept). Restart `npm start` after updating the project
so the stable server can tell tabs which versions it still has. `deploy/` is
not committed.

---

## Using the app

1. Click **Open PDF**, or drag a PDF onto the window.
2. Press **Play**, or click any word on the page to start reading from it.
3. The current sentence is shaded and the current word highlighted, both on
   the page and in the **Reading order** list on the right (below the page on
   narrow windows). Click a paragraph in that list to jump to it.
4. While it reads, the page follows the voice. Scroll yourself (wheel,
   trackpad, scrollbar or keys) to look around the paper while reading goes
   on. A button then shows that the page is no longer following:
   **Back to reading ↑/↓** when the word being read is out of view, **Follow
   reading** when it is in view. Click it and the page follows again.
   Clicking a word or a paragraph, or ⏮ / ⏭, follows again too.

| Control | Action |
| --- | --- |
| **Play / Pause / Resume** | Start, pause and continue reading |
| **⏮ / ⏭** | Previous / next sentence (press ⏮ twice to go back a sentence) |
| **Stop** | Stop reading and clear the highlights |
| **Speed** | Reading speed, 0.5× to 2× |
| **Voice** | Any voice installed on your computer |
| **Page [ 3 ] / 14** | The page you are looking at. Type a page number and press <kbd>Enter</kbd> to go there; <kbd>↑</kbd> / <kbd>↓</kbd> in the field step one page |
| **≈ 47 min** / **≈ 31 min left** | Estimated reading time at the selected speed: for the whole document, then from the word being read. It counts only what will be read (the filters apply) and measures your voice's speed as it reads, remembering it per voice |
| **− [ 100 ] % + Fit** | Zoom out / in, or type a zoom (25–400) and press <kbd>Enter</kbd>; **Fit** fits the page to the window width. The zoom is remembered |
| <kbd>Ctrl</kbd> (<kbd>⌘</kbd> on a Mac) + <kbd>+</kbd> / <kbd>−</kbd> / <kbd>0</kbd> | Zoom in / out / fit to width |
| Pinch, or <kbd>Ctrl</kbd> + scroll | Zoom around the pointer |

The page and zoom fields take numbers only: other characters, typed or
pasted, are dropped, and values out of range are brought into range.
| <kbd>Space</kbd> | Play / pause |
| <kbd>←</kbd> / <kbd>→</kbd> | Previous / next sentence |
| <kbd>Esc</kbd> | Close the Filters menu |

Speed, voice, filters and zoom are remembered in your browser as you change
them, so they stay the same after an update and the next time you open the
app.

### Filters

Open **Filters** in the top bar. Changes apply immediately.

| Option | Default | Effect |
| --- | --- | --- |
| Show layout | off | Draws the detected columns, reading order (§1, §2 …), skipped headers and figure/table text on the page |
| Skip citations | on | Skips reference numbers: `[3]`, `[3,2,1,44,55]`, `[4–9, 12]`, `[3; 5]`, `[3]–[5]`, `[Smi20, Doe21]`, even when broken across lines. Intervals such as `[0, 1]` are kept. |
| Skip captions | off | Skips "Figure N: …" and "Table N: …" captions |
| Skip tables | on | Skips table cells. When off, a table is read after its caption, row by row with its column names |
| Expand abbreviations | on | "Fig. 2" → "Figure 2", "§4.1" → "Section 4.1", "e.g." → "for example", URLs → "link to example.com", ✗ → "cross" |
| Read footnotes | on | Reads footnotes after the paragraph they interrupt |
| Read equations as text | off | Display maths is announced as "equation 3" unless this is on |

### Voices

The app uses the voices installed on your system:

- **Windows:** in **Microsoft Edge** you also get the high-quality
  "Microsoft … Online (Natural)" voices. More offline voices: *Settings →
  Time & language → Speech → Add voices*.
- **macOS:** *System Settings → Accessibility → Spoken Content → System voice
  → Manage Voices* to download better ("Enhanced" / "Premium") voices.

Word highlighting needs a voice that reports word positions. Most system and
Microsoft voices do; if a voice only highlights whole sentences, pick another.

---

## Building for hosting

The app is a static website, so it can be hosted anywhere that serves files
(GitHub Pages, Netlify, a web server, a shared folder behind any HTTP server).

```bash
npm run build      # writes the site to dist/
npm run preview    # serves dist/ at http://localhost:4173 to check it
```

Upload the contents of `dist/`. If the site will live in a sub-folder (for
example GitHub Pages at `https://m0nt31r1nh0.github.io/Read-Aloud/`), build
with that path:

```bash
npm run build -- --base=/Read-Aloud/
```

Opening `dist/index.html` directly from disk (`file://`) does not work;
browsers block the PDF worker there. Always serve it over HTTP.

---

## Publishing this project to GitHub

The project lives at **https://github.com/M0nt31r1nh0/Read-Aloud**. To publish
your own copy instead, create an empty repository at
**https://github.com/new** (leave *Add a README*, *.gitignore* and *license*
unticked) and, inside the project folder:

```bash
git init
git add .
git commit -m "PDF Read Aloud"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repository>.git
git push -u origin main
```

`.gitignore` keeps out `node_modules/`, `dist/`, the generated dictionary and
anything in `test/local/` (put your own PDFs there for testing). Each push
runs the tests and the build on **Windows, macOS and Linux** with GitHub
Actions (`.github/workflows/ci.yml`); the results are on the repository's
**Actions** tab.

---

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with live reload (port 5173) |
| `npm start` | Stable app: serves the last deployed version (port 4173) |
| `npm run deploy` | Tests, then publishes the current source to the stable app |
| `npm test` | Runs the tests, including an end-to-end read of a generated two-column test paper |
| `npm run typecheck` | TypeScript type check |
| `npm run build` | Type check, then production build into `dist/` |
| `npm run inspect -- paper.pdf [--pages 1-3] [--full]` | Prints the reading order the engine produces for a PDF |
| `npm run audit -- paper.pdf` | Flags paragraphs that look wrong (cut in two, leftover headers, odd hyphens, …) |
| `npm run dictionary` | Rebuilds `public/dictionary.txt` (runs automatically before `dev` and `build`) |
| `npm run fixture` | Regenerates the test paper `test/fixtures/two-column.pdf` |

On Windows, quote paths that contain spaces:
`npm run inspect -- "C:\Users\me\Documents\paper.pdf"`.

### Project structure

```
index.html              page and toolbar
src/
  ui/                   app: rendering, highlighting, controls (main.ts)
  speech/reader.ts      speaks one sentence at a time, maps word boundaries to the page
  engine/               PDF → reading units; plain TypeScript, no DOM
scripts/                dictionary build, test-paper generator, inspect/audit tools
test/                   tests (Vitest) and the generated test paper
```

### How a page becomes reading units

`src/engine` is a pure TypeScript module, so it can be reused in another app,
a browser extension or on a server.

| Step | File | What it does |
| --- | --- | --- |
| Extract | `extract.ts` | pdf.js text items → fragments in top-left page space, with one box per character (glyph widths measured with a canvas, scaled to the run's real width). Also reads the page's drawn ruling lines for tables. Rotated text such as arXiv margin stamps is skipped. |
| Lines | `lines.ts` | Groups fragments by baseline and splits a row wherever the gap is wider than a word space (0.8 em), so a line never crosses a column gutter. Small raised/lowered runs are attached to their line as super/subscripts (two passes, for nested indices); rows split by such a mark, and section numbers set a quad from their title, are rejoined. Inline stacked fractions are read "a over b". |
| Margins | `margins.ts` | Drops running headers/footers (same text in the top/bottom margin on 2+ pages) and page numbers. |
| Columns | `columns.ts` | Cuts the page into horizontal slabs at vertical white space, finds gutters in each slab, and re-joins neighbouring slabs that do not bridge the gutter into one column region. Columns are read left to right, full-width blocks top to bottom, rows by baseline then x. The re-join step avoids the classic XY-cut error where paragraph breaks that line up in both columns make the reader zig-zag. |
| Figures | `analyze.ts` | Text drawn inside figures (diagram labels, axis ticks) and table cells: from each "Figure N:"/"Table N:" caption, lines are collected away from the caption until the first body-text line or a wide gap. |
| Tables | `tables.ts` | Rebuilds a grid of cells, then reads it with headers. Bordered tables use the drawn ruling lines: a line's cell is the box of the nearest borders around it, so multi-line cells merge and spanning headers/labels span. Tables with horizontal rules only find columns from vertical white space, the header from the rule under it, and rows from row labels (wrapped cell text joins the label nearest it, whether labels are at the top of the row or centred). |
| Units | `units.ts` | Builds paragraphs from font changes, vertical gaps, first-line indents (told apart from hanging indents) and short last lines. Paragraphs continue across columns, pages and figures. Captions, tables and footnotes are read after the paragraph they interrupted. Numbered headings are told apart from list items; reference entries stay whole and are read "12. Author…". Display maths is read as "equation 3" inside its sentence. |
| Hyphens | `hyphenation.ts`, `dictionary.ts` | Decides each line-end hyphen. The document wins first (`two-column` or `datacenter` written elsewhere); then an English dictionary: join if the joined form is a word (`fre-quently`), keep if both halves are words but the whole is not (`general-purpose`). Also kept: existing compounds (`state-of-the-art`), acronyms (`GPU-based`), capitals/digits after the hyphen (`COVID-19`), prefixes like `self-`. Capitalised words inside a sentence are names and are joined (`Bren-don`). |
| Speech text | `units.ts`, `text.ts` | Ligatures are normalised, the broken "Th" ligature some publishers emit as `+` ("+e") is repaired, superscript marks and citations are skipped, subscripts are read as separate words ("GPU j"), and abbreviations, symbols and URLs are made speakable. |
| Sentences | `sentences.ts` | `Intl.Segmenter` plus guards for `et al.`, initials, `Dr.` and similar; very long sentences are split at `;`/`,`. |

Every spoken character keeps the page box it came from, including words
joined across a line, column or page break, so the word highlight always
lands on the right glyphs. `src/speech/reader.ts` speaks one sentence per
utterance and maps the voice's word-boundary events back to those boxes.

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `npm` fails in PowerShell with "running scripts is disabled on this system" | Use Command Prompt instead, or run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `npm install` says the Node.js version is unsupported (`EBADENGINE`) | Install Node.js 22.13 or newer (LTS) and reopen the terminal |
| `npm warn allow-scripts … fsevents` during install (macOS) | Harmless: an optional macOS file watcher; nothing to do |
| No voices in the Voice list | Wait a second after the page loads; otherwise install voices (see **Voices**) |
| Sentences are highlighted but not single words | The selected voice doesn't report word positions; choose another |
| A blank page after opening `dist/index.html` directly | Serve it over HTTP: `npm run preview` (see **Building for hosting**) |

---

## Known limits

- Tables are found only next to a "Table N" caption; tables with several
  header levels or empty row labels read less cleanly.
- Inline maths in prose is read as plain text, and glyphs a PDF encodes
  wrongly cannot be recovered (e.g. a square-root sign the font maps to "q").
- Technical words missing from the dictionary ("neuro-fuzzy") are joined at a
  line-end hyphen unless the document writes them hyphenated elsewhere.
- Bold-only headings at body size are recognised only when numbered
  ("3.2 Results"); pdf.js does not expose font weight.
- Right-to-left scripts and vertical text are not handled.
- Paragraph detection relies on justified text; in ragged-right documents a
  sentence-final line followed by a new column may be read as one paragraph.

---

## Credits and license

- [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0) renders and reads the PDFs.
- [word-list](https://github.com/sindresorhus/word-list) (MIT, based on
  [SCOWL](http://wordlist.aspell.net/)) provides the hyphenation dictionary.

PDF Read Aloud is released under the [MIT License](LICENSE).
