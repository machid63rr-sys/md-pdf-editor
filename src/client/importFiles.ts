import type { ImportedDocument } from './documents';

/*
 * 取り込んだファイル(複数可)から、編集する文書を決める。
 * - 文書(Markdown または HTML)は1つだけ
 * - CSSは、HTMLと一緒にのみ取り込める(HTMLの <link> と同じ名前のCSSが適用される)
 */

export interface ReadFile {
  readonly name: string;
  readonly text: string;
}

export type ImportResult =
  | { readonly ok: true; readonly document: ImportedDocument }
  | { readonly ok: false; readonly message: string };

const HTML_FILE = /\.(html?|xhtml)$/i;
const CSS_FILE = /\.css$/i;

const fail = (message: string): ImportResult => ({ ok: false, message });

export function classifyImport(files: readonly ReadFile[]): ImportResult {
  const stylesheets = files.filter((file) => CSS_FILE.test(file.name));
  const documents = files.filter((file) => !CSS_FILE.test(file.name));
  const [document] = documents;

  if (document === undefined) {
    return fail(stylesheets.length > 0 ? 'CSSファイルだけは取り込めません。HTMLファイルと一緒に選んでください。' : 'ファイルがありません。');
  }
  if (documents.length > 1) {
    return fail(
      `文書は1つずつ取り込んでください(${documents.map((file) => `「${file.name}」`).join('、')})。HTMLと一緒に取り込めるのは、CSSファイルだけです。`,
    );
  }
  if (document.text.trim() === '') {
    return fail(`「${document.name}」は空のファイルです。`);
  }

  if (!HTML_FILE.test(document.name)) {
    if (stylesheets.length > 0) {
      return fail(`CSSファイルは、HTMLファイルと一緒にのみ取り込めます(「${document.name}」はHTMLではありません)。`);
    }
    return { ok: true, document: { kind: 'markdown', markdown: document.text, sourceName: document.name } };
  }

  const seen = new Set<string>();
  for (const stylesheet of stylesheets) {
    const key = stylesheet.name.toLowerCase();
    if (seen.has(key)) {
      return fail(`同じ名前のCSSファイルが複数あります(「${stylesheet.name}」)。HTMLからは名前で参照するため、区別できません。`);
    }
    seen.add(key);
  }
  return {
    ok: true,
    document: {
      kind: 'html',
      html: document.text,
      stylesheets: stylesheets.map((file) => ({ name: file.name, text: file.text })),
      sourceName: document.name,
    },
  };
}
