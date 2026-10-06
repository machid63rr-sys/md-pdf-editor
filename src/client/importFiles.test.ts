import { describe, expect, it } from 'vitest';
import { classifyImport } from './importFiles';

const file = (name: string, text = '内容'): { name: string; text: string } => ({ name, text });

describe('classifyImport', () => {
  it.each(['manual.md', 'a.markdown', 'memo.txt', 'README'])('%s はMarkdownとして取り込む', (name) => {
    expect(classifyImport([file(name, '# 見出し')])).toEqual({
      ok: true,
      document: { kind: 'markdown', markdown: '# 見出し', sourceName: name },
    });
  });

  it.each(['index.html', 'index.HTM', 'a.xhtml'])('%s はHTMLとして取り込む', (name) => {
    expect(classifyImport([file(name, '<p>x</p>')])).toEqual({
      ok: true,
      document: { kind: 'html', html: '<p>x</p>', stylesheets: [], sourceName: name },
    });
  });

  it('HTMLと一緒に選んだCSSは、順序によらずHTMLに付く', () => {
    const result = classifyImport([file('style.css', 'p{}'), file('index.html', '<p>x</p>'), file('print.CSS', 'a{}')]);
    expect(result).toEqual({
      ok: true,
      document: {
        kind: 'html',
        html: '<p>x</p>',
        stylesheets: [
          { name: 'style.css', text: 'p{}' },
          { name: 'print.CSS', text: 'a{}' },
        ],
        sourceName: 'index.html',
      },
    });
  });

  it('空のCSSは取り込める(空のHTML・Markdownは取り込めない)', () => {
    expect(classifyImport([file('a.html', '<p>x</p>'), file('empty.css', '')]).ok).toBe(true);
    const empty = classifyImport([file('a.html', ' \n')]);
    expect(empty).toEqual({ ok: false, message: '「a.html」は空のファイルです。' });
    expect(classifyImport([file('a.md', '')]).ok).toBe(false);
  });

  it.each([
    ['CSSだけ', [file('style.css')], 'CSSファイルだけは取り込めません'],
    ['Markdownと一緒のCSS', [file('a.md'), file('style.css')], 'HTMLファイルと一緒にのみ'],
    ['HTMLが2つ', [file('a.html'), file('b.html')], '1つずつ取り込んでください'],
    ['MarkdownとHTML', [file('a.md'), file('b.html')], '1つずつ取り込んでください'],
    ['同名のCSS(大文字小文字違い)', [file('a.html'), file('S.css'), file('s.CSS')], '同じ名前のCSS'],
    ['何も無い', [], 'ファイルがありません'],
  ])('%sは取り込まず、理由を示す', (_label, files, message) => {
    const result = classifyImport(files);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(message);
  });
});
