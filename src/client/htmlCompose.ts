import { parse, type DefaultTreeAdapterMap } from 'parse5';

/*
 * 取り込んだHTMLと、一緒に取り込んだCSSから、プレビュー・PDF生成に使う「ひとつの文書」を作る。
 *
 * 元のHTMLを作り直さず、挿入・置換する位置だけをソース上で特定して差し込む。
 * (書き直すと、プレビューのDOMと元のHTMLの構造がずれ、編集内容を元のHTMLへ反映できなくなるため)
 */

export interface Stylesheet {
  readonly name: string;
  readonly text: string;
}

type Node = DefaultTreeAdapterMap['node'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface ComposeOptions {
  // true: プレビュー用。外部への通信を禁じるCSPと、メタリフレッシュの除去を加える
  readonly preview: boolean;
}

// プレビューは、サーバ側のPDF生成(JS無効・外部通信遮断)と同じく、外部へ一切通信させない
const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'";

const isElement = (node: Node): node is Element => 'tagName' in node;
const childrenOf = (node: ParentNode): Node[] => node.childNodes as Node[];

export const attributeOf = (element: Element, name: string): string | undefined =>
  element.attrs.find((attr) => attr.name === name)?.value;

// "css/style.css?v=2#x" -> "style.css"
export function stylesheetBaseName(href: string): string {
  const path = href.trim().split(/[?#]/)[0] ?? '';
  const last = path.split(/[\\/]/).pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export const isStylesheetLink = (element: Element): boolean =>
  element.tagName === 'link' &&
  (attributeOf(element, 'rel') ?? '')
    .toLowerCase()
    .split(/\s+/)
    .includes('stylesheet') &&
  attributeOf(element, 'href') !== undefined;

// HTMLの<link>が参照している名前(ファイル名)と、取り込んだCSSの名前を、大文字小文字を区別せずに突き合わせる
export function findStylesheet(href: string, stylesheets: readonly Stylesheet[]): Stylesheet | undefined {
  const name = stylesheetBaseName(href).toLowerCase();
  return stylesheets.find((stylesheet) => stylesheet.name.toLowerCase() === name);
}

export function walkElements(node: ParentNode, visit: (element: Element, insideHead: boolean) => void, insideHead = false): void {
  for (const child of childrenOf(node)) {
    if (isElement(child)) {
      visit(child, insideHead);
      walkElements(child, visit, insideHead || child.tagName === 'head');
    }
  }
}

function childElement(parent: ParentNode, tagName: string): Element | undefined {
  return childrenOf(parent).find((child): child is Element => isElement(child) && child.tagName === tagName);
}

// 本文(body)の最初の内容の位置。本文が空なら文書の末尾
function bodyContentStart(body: Element | undefined, sourceLength: number): number {
  if (body === undefined) {
    return sourceLength;
  }
  const startTag = body.sourceCodeLocation?.startTag;
  if (startTag) {
    return startTag.startOffset;
  }
  for (const child of childrenOf(body)) {
    const location = (child as { sourceCodeLocation?: { startOffset: number } | null }).sourceCodeLocation;
    if (location) {
      return location.startOffset;
    }
  }
  return sourceLength;
}

interface DocumentPositions {
  // <head>の先頭(ここへ挿入した要素は、必ずheadに入る)
  readonly headStart: number;
  // </head>の直前(ここへ挿入した<style>は、headに入り、本文より前に置かれる)
  readonly headEnd: number;
}

function documentPositions(document: ParentNode, sourceLength: number): DocumentPositions {
  const html = childElement(document, 'html');
  const head = html && childElement(html, 'head');
  const body = html && childElement(html, 'body');

  let headStart = 0;
  const headStartTag = head?.sourceCodeLocation?.startTag;
  const htmlStartTag = html?.sourceCodeLocation?.startTag;
  if (headStartTag) {
    headStart = headStartTag.endOffset;
  } else if (htmlStartTag) {
    headStart = htmlStartTag.endOffset;
  } else {
    const doctype = childrenOf(document).find((child) => child.nodeName === '#documentType');
    headStart = (doctype as { sourceCodeLocation?: { endOffset: number } | null } | undefined)?.sourceCodeLocation?.endOffset ?? 0;
  }

  const headEndTag = head?.sourceCodeLocation?.endTag;
  const headEnd = headEndTag ? headEndTag.startOffset : bodyContentStart(body, sourceLength);
  return { headStart, headEnd: Math.max(headEnd, headStart) };
}

// <style>の中では「</style」が文字列として現れてはならない(CSSとしては意味を持たないため、無害な形にする)
const styleElement = (css: string): string => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;

function applyEdits(source: string, edits: readonly Edit[]): string {
  return edits
    .map((edit, order) => ({ edit, order }))
    .sort((a, b) => b.edit.start - a.edit.start || b.order - a.order)
    .reduce((result, { edit }) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), source);
}

/**
 * HTMLに、取り込んだCSSを適用した文書を返す。
 * - <head>内の <link rel="stylesheet" href="…"> のうち、取り込んだCSSと名前が一致するものは、その位置へCSSを埋め込む
 * - <body>内の <link> や、どの <link> にも参照されていないCSSは、<head>の末尾へ追加する
 * - プレビュー用には、外部通信を禁じるCSPを加え、メタリフレッシュ(別ページへの自動移動)を除く
 */
export function composeHtml(source: string, stylesheets: readonly Stylesheet[], options: ComposeOptions): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const positions = documentPositions(document, source.length);
  const edits: Edit[] = [];
  // 同じ位置への挿入は、先に追加したものが前に並ぶ。CSPは、どの要素よりも先に置く
  if (options.preview) {
    edits.push({
      start: positions.headStart,
      end: positions.headStart,
      text: `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
    });
  }
  const used = new Set<Stylesheet>();
  const appended: Stylesheet[] = [];

  walkElements(document, (element, insideHead) => {
    const location = element.sourceCodeLocation;
    if (isStylesheetLink(element)) {
      const stylesheet = findStylesheet(attributeOf(element, 'href') ?? '', stylesheets);
      if (stylesheet !== undefined && !used.has(stylesheet)) {
        used.add(stylesheet);
        if (insideHead && location) {
          edits.push({ start: location.startOffset, end: location.endOffset, text: styleElement(stylesheet.text) });
        } else {
          appended.push(stylesheet);
        }
      }
      return;
    }
    if (
      options.preview &&
      insideHead &&
      location &&
      element.tagName === 'meta' &&
      (attributeOf(element, 'http-equiv') ?? '').toLowerCase() === 'refresh'
    ) {
      edits.push({ start: location.startOffset, end: location.endOffset, text: '' });
    }
  });

  for (const stylesheet of stylesheets) {
    if (!used.has(stylesheet)) {
      appended.push(stylesheet);
    }
  }
  if (appended.length > 0) {
    edits.push({ start: positions.headEnd, end: positions.headEnd, text: appended.map((s) => styleElement(s.text)).join('') });
  }
  return applyEdits(source, edits);
}
