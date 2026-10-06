import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { attributeOf, findStylesheet, isStylesheetLink, walkElements, type Stylesheet } from './htmlCompose';
import type { LintWarning } from './lint';

/*
 * 出力前に利用者へ知らせるべき「PDFやプレビューで期待と違う見え方になるHTML・CSS」を検出する。
 * PDFは、JavaScriptを実行せず、外部へ通信しない状態で描画するため、次のものは反映されない。
 */

type Element = DefaultTreeAdapterMap['element'];

const MESSAGES = {
  script: 'スクリプト(<script>・onclick など)は実行されません。',
  noscript: '<noscript>の内容は、JavaScriptを実行しないため、そのまま表示されます。',
  'stylesheet-missing':
    '取り込んでいないCSS(<link rel="stylesheet">)は適用されません。CSSファイルも一緒に取り込んでください。',
  'external-resource': '外部の画像・フォント・ファイル(data URI以外)は表示されません。',
} as const;

// 外部ファイルを指す属性。要素ごとに、読み込みに使われるものだけを見る
const RESOURCE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  img: ['src', 'srcset'],
  source: ['src', 'srcset'],
  video: ['src', 'poster'],
  audio: ['src'],
  iframe: ['src'],
  embed: ['src'],
  object: ['data'],
  input: ['src'],
};

const CSS_URL = /url\(\s*(['"]?)\s*(?!data:|#|['"]?\s*\))([^'")]+?)\1\s*\)/gi;
const CSS_IMPORT = /@import\b/i;

const isExternal = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed !== '' && !/^data:/i.test(trimmed) && !trimmed.startsWith('#');
};

// srcset は「URL 幅, URL 幅 …」の形。URLの部分だけを取り出す
const srcsetUrls = (value: string): string[] =>
  value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
    .filter((url) => url !== '');

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

function cssExternalLines(css: string): number[] {
  const lines: number[] = [];
  for (const match of css.matchAll(CSS_URL)) {
    lines.push(lineOf(css, match.index));
  }
  const importMatch = CSS_IMPORT.exec(css);
  if (importMatch) {
    lines.push(lineOf(css, importMatch.index));
  }
  return lines;
}

const sorted = (lines: Iterable<number>): number[] => [...new Set(lines)].sort((a, b) => a - b);

export function lintHtml(source: string, stylesheets: readonly Stylesheet[]): LintWarning[] {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const lines: Record<keyof typeof MESSAGES, number[]> = { script: [], noscript: [], 'stylesheet-missing': [], 'external-resource': [] };
  const referenced = new Set<Stylesheet>();

  const lineAt = (element: Element): number => element.sourceCodeLocation?.startLine ?? 0;

  walkElements(document, (element) => {
    if (element.tagName === 'script' || element.attrs.some((attr) => /^on/i.test(attr.name))) {
      lines.script.push(lineAt(element));
    }
    if (element.tagName === 'noscript') {
      lines.noscript.push(lineAt(element));
    }
    if (isStylesheetLink(element)) {
      const stylesheet = findStylesheet(attributeOf(element, 'href') ?? '', stylesheets);
      if (stylesheet === undefined) {
        lines['stylesheet-missing'].push(lineAt(element));
      } else {
        referenced.add(stylesheet);
      }
      return;
    }
    for (const name of RESOURCE_ATTRIBUTES[element.tagName] ?? []) {
      const value = attributeOf(element, name);
      if (value === undefined) {
        continue;
      }
      const urls = name === 'srcset' ? srcsetUrls(value) : [value];
      if (urls.some(isExternal)) {
        lines['external-resource'].push(lineAt(element));
      }
    }
    const inlineStyle = attributeOf(element, 'style');
    if (inlineStyle !== undefined && cssExternalLines(inlineStyle).length > 0) {
      lines['external-resource'].push(lineAt(element));
    }
    if (element.tagName === 'style') {
      const css = (element.childNodes as { nodeName: string; value?: string }[]).map((node) => node.value ?? '').join('');
      const start = element.sourceCodeLocation?.startTag?.endLine ?? lineAt(element);
      for (const line of cssExternalLines(css)) {
        lines['external-resource'].push(start + line - 1);
      }
    }
  });

  const warnings: LintWarning[] = [];
  const add = (code: keyof typeof MESSAGES, found: Iterable<number>): void => {
    const result = sorted(found);
    if (result.length > 0) {
      warnings.push({ code, message: MESSAGES[code], lines: result });
    }
  };
  add('script', lines.script);
  add('noscript', lines.noscript);
  add('stylesheet-missing', lines['stylesheet-missing']);
  add('external-resource', lines['external-resource']);

  for (const stylesheet of stylesheets) {
    const external = cssExternalLines(stylesheet.text);
    if (external.length > 0) {
      warnings.push({
        code: `external-resource:${stylesheet.name}`,
        message: `CSS「${stylesheet.name}」の外部ファイル(@import・url(…)。data URI以外)は読み込まれません。`,
        lines: sorted(external),
      });
    }
    if (!referenced.has(stylesheet)) {
      warnings.push({
        code: `unreferenced-stylesheet:${stylesheet.name}`,
        message: `CSS「${stylesheet.name}」を参照する <link> がHTMLに無いため、<head>の末尾に追加して適用します(保存するHTMLは変わりません)。`,
        lines: [],
      });
    }
  }
  return warnings;
}
