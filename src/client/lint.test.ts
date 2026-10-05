import { describe, expect, it } from 'vitest';
import { lintMarkdown } from './lint';

const codes = (markdown: string): string[] => lintMarkdown(markdown).map((warning) => warning.code);
const linesOf = (markdown: string, code: string): readonly number[] | undefined =>
  lintMarkdown(markdown).find((warning) => warning.code === code)?.lines;

describe('lintMarkdown', () => {
  it('問題の無いMarkdownは警告なし', () => {
    const markdown = '# 見出し\n\n本文 **太字** と `code`。[リンク](https://example.com)\n\n| a | b |\n| - | - |\n| 1 | 2 |';
    expect(lintMarkdown(markdown)).toEqual([]);
  });

  describe('front matter', () => {
    it('先頭のfront matterを検出する', () => {
      expect(linesOf('---\ntitle: T\n---\n\n本文', 'front-matter')).toEqual([1]);
    });

    it('閉じていない---や、先頭でない---は対象外', () => {
      expect(codes('---\n本文だけ')).toEqual([]);
      expect(codes('本文\n\n---\nx\n---')).toEqual([]);
    });

    it('front matter内の記述は、他の検査の対象にしない', () => {
      expect(codes('---\nnote: <b>x</b>\n---\n本文')).toEqual(['front-matter']);
    });
  });

  describe('画像', () => {
    it('外部URLの画像を、行番号つきで検出する', () => {
      expect(linesOf('本文\n\n![図](https://example.com/a.png)', 'unsupported-image')).toEqual([3]);
      expect(linesOf('![図](./a.png)', 'unsupported-image')).toEqual([1]);
    });

    it('data URIの画像は警告しない(大文字小文字を問わない)', () => {
      expect(codes('![p](data:image/png;base64,AAAA)')).toEqual([]);
      expect(codes('![p](DATA:image/png;base64,AAAA)')).toEqual([]);
    });

    it('コードフェンス内・インラインコード内の画像記法は対象外', () => {
      expect(codes('```\n![図](https://example.com/a.png)\n```')).toEqual([]);
      expect(codes('書き方は `![図](https://example.com/a.png)` です')).toEqual([]);
    });
  });

  describe('生HTML', () => {
    it('<br>・<div>・コメントを検出する', () => {
      expect(linesOf('a<br>b\n\n<div>x</div>\n\n<!-- c -->', 'raw-html')).toEqual([1, 3, 5]);
      expect(codes('改行<br/>です')).toEqual(['raw-html']);
    });

    it('自動リンクや日本語の山括弧、比較式は生HTMLとみなさない', () => {
      expect(codes('<https://example.com/a> と <foo@example.com>')).toEqual([]);
      expect(codes('画面の <エラー一覧表> を見る')).toEqual([]);
      expect(codes('a < b かつ c > d')).toEqual([]);
    });

    it('コードの内側は対象外', () => {
      expect(codes('`<br>` と書く')).toEqual([]);
      expect(codes('```html\n<div>x</div>\n```')).toEqual([]);
    });
  });

  describe('崩れた表', () => {
    it('表として成立しない表形式の行を、先頭行の行番号で報告する', () => {
      expect(linesOf('本文\n\n| a | b | c |\n| --- | --- |\n| 1 | 2 |', 'broken-table')).toEqual([3]);
    });
  });

  it('複数の警告は、front matter・表・画像・HTMLの順に並ぶ', () => {
    const markdown = '---\nt: 1\n---\n\n![a](x.png)\n\n<br>\n\n| a | b | c |\n| - | - |';
    expect(codes(markdown)).toEqual(['front-matter', 'broken-table', 'unsupported-image', 'raw-html']);
  });
});
