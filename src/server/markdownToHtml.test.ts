import { describe, expect, it } from 'vitest';
import { buildDocumentHtml, renderMarkdown, type MarkdownAssets } from './markdownToHtml.js';

const body = (markdown: string): string => renderMarkdown(markdown).bodyHtml;

describe('renderMarkdown', () => {
  it('GFMの表をtable要素にする', () => {
    const html = body('| 項目 | 説明 |\n| --- | --- |\n| A | 最初 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>項目</th>');
    expect(html).toContain('<td>最初</td>');
  });

  it('見出し・強調・コードを変換する', () => {
    const html = body('# 見出し\n\n**太字** と `code`\n\n```python\nprint(1)\n```');
    expect(html).toContain('<h1>見出し</h1>');
    expect(html).toContain('<strong>太字</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<pre><code class="language-python">print(1)\n</code></pre>');
  });

  it('山括弧で囲まれた日本語(エラー一覧表など)は文字として残る', () => {
    expect(body('画面に <エラー一覧表> と出ます')).toContain('&#x3C;エラー一覧表>');
  });

  it('段落内の改行は改行(br)になる', () => {
    expect(body('1行目\n2行目')).toContain('1行目<br>\n2行目');
  });

  describe('生HTML', () => {
    it('scriptやイベント属性は実行されず、文字として表示される', () => {
      const html = body('<script>alert(1)</script>\n\n文中の <img src=x onerror=alert(1)> です');
      expect(html).not.toContain('<script');
      expect(html).not.toContain('<img');
      expect(html).toContain('&#x3C;script>alert(1)&#x3C;/script>');
      expect(html).toContain('&#x3C;img src=x onerror=alert(1)>');
    });

    it('表セル内の<br>も黙って消さず、文字として表示する', () => {
      expect(body('| a |\n| - |\n| 1<br>2 |')).toContain('1&#x3C;br>2');
    });

    it('複数行のHTMLブロックは改行を保つ', () => {
      const html = body('<div>\n本文\n</div>');
      expect(html).toContain('&#x3C;div>');
      expect(html).toContain('<br>');
      expect(html).toContain('&#x3C;/div>');
    });
  });

  describe('front matter', () => {
    it('YAMLコードブロックとして内容を残す', () => {
      const html = body('---\ntitle: T\ntags: [a, b]\n---\n\n本文');
      expect(html).toContain('<pre><code class="language-yaml">title: T\ntags: [a, b]\n</code></pre>');
      expect(html).toContain('<p>本文</p>');
    });
  });

  describe('リンク', () => {
    it('http/https/mailto/相対/フラグメントはリンクのまま', () => {
      const html = body('[a](https://example.com) [b](mailto:x@example.com) [c](./rel.md) [d](#sec)');
      expect(html).toContain('<a href="https://example.com">a</a>');
      expect(html).toContain('<a href="mailto:x@example.com">b</a>');
      expect(html).toContain('<a href="./rel.md">c</a>');
      expect(html).toContain('<a href="#sec">d</a>');
    });

    it('javascript:等はリンクにせず「文字 (URL)」にする', () => {
      const html = body('[クリック](javascript:alert(1))');
      expect(html).not.toContain('href');
      expect(html).toContain('クリック');
      expect(html).toContain('(javascript:alert(1))');
    });

    it('参照形式で定義された危険なURLも同様に無効化する', () => {
      const html = body('[x][ref]\n\n[ref]: javascript:alert(1)');
      expect(html).not.toContain('href');
      expect(html).toContain('(javascript:alert(1))');
    });
  });

  describe('画像', () => {
    const dataUri =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    it('data URI(png)は画像として表示する', () => {
      expect(body(`![点](${dataUri})`)).toContain(`<img src="${dataUri}" alt="点">`);
    });

    it('外部URLの画像は、読み込まず「[画像: 代替文](URL)」の文字にする', () => {
      const html = body('![外部](https://example.com/a.png)');
      expect(html).not.toContain('<img');
      expect(html).toContain('[画像: 外部](https://example.com/a.png)');
    });

    it('svgのdata URIも画像として表示する(<img>の中では、スクリプトの実行も外部の読み込みも行われない)', () => {
      const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
      expect(body(`![s](${svg})`)).toContain(`<img src="${svg}" alt="s">`);
    });

    it('画像として許可していない種類・形のdata URIは、文字にする', () => {
      for (const src of ['data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;utf8,AAA', 'data:application/pdf;base64,AAAA']) {
        const html = body(`![x](${src})`);
        expect(html).not.toContain('<img');
        expect(html).toContain('[画像: x](');
      }
    });

    describe('取り込んだ画像(assets)', () => {
      const assets: MarkdownAssets = { baseDir: 'docs', files: { 'docs/img/a.png': dataUri, 'shared/b.png': dataUri } };
      const render = (markdown: string, given: MarkdownAssets = assets): string => renderMarkdown(markdown, given).bodyHtml;

      it('Markdownのフォルダを基準にした相対パスの画像を、渡された画像で表示する(元のパスは変わらず、src だけが置き換わる)', () => {
        expect(render('![図](img/a.png)')).toContain(`<img src="${dataUri}" alt="図">`);
        expect(render('![図](./img/a.png?v=2)')).toContain(`<img src="${dataUri}"`);
        expect(render('![図](../shared/b.png)')).toContain(`<img src="${dataUri}"`);
        expect(render('![図](/shared/b.png)')).toContain(`<img src="${dataUri}"`);
      });

      it('参照形式・空白を含むパス・パーセントエンコードされたパスの画像も表示する', () => {
        const files = { 'docs/my img/日本.png': dataUri };
        expect(render('![図][a]\n\n[a]: img/a.png', assets)).toContain(`<img src="${dataUri}"`);
        expect(render('![図](<my img/日本.png>)', { baseDir: 'docs', files })).toContain(`<img src="${dataUri}"`);
        expect(render('![図](my%20img/%E6%97%A5%E6%9C%AC.png)', { baseDir: 'docs', files })).toContain(`<img src="${dataUri}"`);
      });

      it('渡されていない画像・外部URL・ルートの外を指す画像は、文字にする', () => {
        for (const markdown of ['![x](img/none.png)', '![x](https://example.com/a.png)', '![x](../../a.png)']) {
          const html = render(markdown);
          expect(html).not.toContain('<img');
          expect(html).toContain('[画像: x](');
        }
      });

      it('渡された値が画像のdata URIでなければ、信用せず、文字にする', () => {
        const html = render('![x](img/a.png)', { baseDir: 'docs', files: { 'docs/img/a.png': 'javascript:alert(1)' } });
        expect(html).not.toContain('<img');
        expect(html).toContain('[画像: x](img/a.png)');
      });

      it('画像が渡されていなければ、相対パスの画像は文字にする(従来どおり)', () => {
        const html = renderMarkdown('![x](img/a.png)').bodyHtml;
        expect(html).not.toContain('<img');
        expect(html).toContain('[画像: x](img/a.png)');
      });

      it('Object.prototypeのプロパティ名のパスを指しても、画像にならない', () => {
        expect(render('![x](constructor)', { baseDir: '', files: {} })).not.toContain('<img');
      });
    });
  });

  it('最初のH1をタイトルにする。無ければ「無題」', () => {
    expect(renderMarkdown('本文\n\n# 取扱説明書 *第2版*').title).toBe('取扱説明書 第2版');
    expect(renderMarkdown('## 小見出しだけ').title).toBe('無題');
  });
});

describe('buildDocumentHtml', () => {
  it('lang=jaの完全なHTMLで、CSSとbody.documentを含む。タイトルはエスケープされる', () => {
    const html = buildDocumentHtml('# A & <B>', '.x{color:red}');
    expect(html).toMatch(/^<!doctype html><html lang="ja">/);
    expect(html).toContain('<style>.x{color:red}</style>');
    expect(html).toContain('<body class="document">');
    expect(html).toContain('<title>A &amp; &lt;B&gt;</title>');
    expect(html).toContain("default-src 'none'");
  });
});
