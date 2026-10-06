import type { Stylesheet } from './htmlCompose';

/** 取り込んだ文書。Markdownは1ファイル、HTMLはCSSファイル(0個以上)と一緒に取り込む */
export interface MarkdownDocument {
  readonly kind: 'markdown';
  readonly markdown: string;
  // 取り込んだファイル名。貼り付けの場合はnull
  readonly sourceName: string | null;
}

export interface HtmlDocument {
  readonly kind: 'html';
  readonly html: string;
  // HTMLと一緒に取り込んだCSS(HTMLの<link>と同じ名前のものが適用される)
  readonly stylesheets: readonly Stylesheet[];
  readonly sourceName: string | null;
}

export type ImportedDocument = MarkdownDocument | HtmlDocument;
