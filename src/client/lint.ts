import { forEachLineOutsideFences, splitInlineCode } from './markdownText';
import { findBrokenTables } from './tableCheck';

/*
 * 出力前に利用者へ知らせるべき「PDFやプレビューで期待と違う見え方になる記法」を検出する。
 * いずれも内容は失われない(文字として残る)が、黙って見え方が変わることを避けるための警告。
 */

export type LintCode = 'front-matter' | 'broken-table' | 'unsupported-image' | 'raw-html';

export interface LintWarning {
  // 警告の種類。Markdown用はLintCode。HTML用(lintHtml)は別の値も取る
  readonly code: string;
  readonly message: string;
  // 該当する行番号(1始まり)
  readonly lines: readonly number[];
}

const MESSAGES: Record<LintCode, string> = {
  'front-matter': '先頭のfront matterは、PDFではYAMLのコードブロックとして表示されます。',
  'broken-table': '表として解釈できない表形式の行があります。PDFでは「|」付きの文字のまま表示されます。',
  'unsupported-image': 'data URI以外の画像は、PDFには表示されません(「[画像: …]」という文字になります)。',
  'raw-html': 'HTMLタグ(<br> など)は実行されず、文字としてそのまま表示されます。',
};

const IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]*)/g;
// タグ名はASCII英字で始まるものだけ(<https://…> の自動リンクや <エラー一覧表> は含めない)
const RAW_HTML = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<!--/;

// 先頭のfront matter(--- で始まり、後で --- か ... で閉じる)が占める行数。無ければ0
function frontMatterLineCount(markdown: string): number {
  const lines = markdown.split('\n');
  if (lines[0]?.trimEnd() !== '---') {
    return 0;
  }
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? '').trimEnd();
    if (trimmed === '---' || trimmed === '...') {
      return i + 1;
    }
  }
  return 0;
}

const withoutInlineCode = (line: string): string =>
  splitInlineCode(line)
    .filter((segment) => !segment.code)
    .map((segment) => segment.text)
    .join(' ');

export function lintMarkdown(markdown: string): LintWarning[] {
  const frontMatterLines = frontMatterLineCount(markdown);
  const imageLines: number[] = [];
  const htmlLines: number[] = [];

  forEachLineOutsideFences(markdown, (line, lineNumber) => {
    if (lineNumber <= frontMatterLines) {
      return;
    }
    const prose = withoutInlineCode(line);
    const hasUnsupportedImage = [...prose.matchAll(IMAGE)].some(
      (match) => !(match[1] ?? '').toLowerCase().startsWith('data:image/'),
    );
    if (hasUnsupportedImage) {
      imageLines.push(lineNumber);
    }
    if (RAW_HTML.test(prose)) {
      htmlLines.push(lineNumber);
    }
  });

  const warnings: LintWarning[] = [];
  const add = (code: LintCode, lines: readonly number[]): void => {
    if (lines.length > 0) {
      warnings.push({ code, message: MESSAGES[code], lines });
    }
  };
  add('front-matter', frontMatterLines > 0 ? [1] : []);
  add(
    'broken-table',
    findBrokenTables(markdown).map((table) => table.line),
  );
  add('unsupported-image', imageLines);
  add('raw-html', htmlLines);
  return warnings;
}
