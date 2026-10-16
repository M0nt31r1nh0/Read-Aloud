// All geometry is in page space: PDF points at scale 1, origin at the
// page's top-left corner, y growing downwards.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A straight horizontal or vertical line drawn on the page (table borders). */
export interface Rule {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface CharBox extends Rect {
  page: number;
}

/** A run of text as reported by the PDF text layer. */
export interface Fragment {
  page: number;
  text: string;
  x: number;
  top: number;
  width: number;
  height: number;
  baseline: number;
  fontSize: number;
  fontName: string;
  /** One box per UTF-16 code unit of `text`. */
  chars: Rect[];
  /** Raised or lowered small text attached to a body line (footnote marks). */
  script?: 'super' | 'sub';
}

export interface Line {
  page: number;
  /** Sorted left to right. */
  fragments: Fragment[];
  box: Rect;
  baseline: number;
  fontSize: number;
  fontName: string;
  /** Index into the page's blocks, assigned by reading-order analysis. */
  block?: number;
  /** Footnotes are read after their paragraph; figure text is not read. */
  role?: 'footnote' | 'figure' | 'table';
  /** A footnote for certain: it is under the footnote rule. */
  underFootnoteRule?: boolean;
  /** Starts like a caption ("Table 5. …") but goes on with the sentence above. */
  inText?: boolean;
  /** The caption a figure or table line belongs to. */
  group?: string;
}

export interface Block {
  page: number;
  order: number;
  kind: 'full' | 'column';
  box: Rect;
}

export interface PageLayout {
  page: number;
  width: number;
  height: number;
  /** Reading order. Footnotes are moved to the end of the page. */
  lines: Line[];
  blocks: Block[];
  /** Running headers, footers, page numbers and text inside figures: not read. */
  dropped: Line[];
  /** Ruling lines, used to rebuild bordered tables. */
  rules: Rule[];
}

export interface Sentence {
  start: number;
  end: number;
}

export type UnitKind = 'heading' | 'paragraph' | 'caption' | 'footnote' | 'equation' | 'table';

/** What the voice reads in one go, with a page box for every character. */
export interface ReadingUnit {
  id: number;
  kind: UnitKind;
  text: string;
  /** Same length as `text`; null for inserted characters such as joining spaces. */
  boxes: (CharBox | null)[];
  sentences: Sentence[];
}

export interface AnalyzeOptions {
  /** Drop citations such as "[3]", "[3,2,1,44,55]", "[4–9]" or "[Smi20]". */
  skipCitations: boolean;
  /** Leave out figure and table captions ("Figure 3: …"). */
  skipCaptions: boolean;
  /** Leave out the cells of tables; otherwise read them row by row. */
  skipTables: boolean;
  /** Expand "Fig. 2", "Eq. 4", "e.g." and similar for the voice. */
  expandAbbreviations: boolean;
  /** Leave footnotes out instead of reading them after their paragraph. */
  skipFootnotes: boolean;
  /** Read display maths symbol by symbol instead of saying "equation 3". */
  readEquationText: boolean;
}

export const DEFAULT_OPTIONS: AnalyzeOptions = {
  skipCitations: true,
  skipCaptions: false,
  skipTables: true,
  expandAbbreviations: true,
  skipFootnotes: false,
  readEquationText: false,
};
