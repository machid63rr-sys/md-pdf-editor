import { describe, expect, it } from 'vitest';
import { buildDocumentHtml, renderMarkdown } from './markdownToHtml.js';

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

    it('svgのdata URIは対象外として文字にする', () => {
      const html = body('![s](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)');
      expect(html).not.toContain('<img');
      expect(html).toContain('[画像: s](');
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
