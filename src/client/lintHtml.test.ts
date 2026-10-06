import { describe, expect, it } from 'vitest';
import { lintHtml } from './lintHtml';

const CSS = { name: 'style.css', text: 'p { color: red; }' };
const codes = (html: string, css = [CSS]): string[] => lintHtml(html, css).map((warning) => warning.code);
const lines = (html: string, code: string, css = [CSS]): readonly number[] | undefined =>
  lintHtml(html, css).find((warning) => warning.code === code)?.lines;

describe('lintHtml', () => {
  it('問題が無ければ警告なし', () => {
    const html = '<head><link rel="stylesheet" href="style.css"></head><body><p>x</p><img src="data:image/png;base64,AAAA"></body>';
    expect(lintHtml(html, [CSS])).toEqual([]);
  });

  it('スクリプトとイベント属性は、実行されない旨を行番号つきで警告する', () => {
    expect(lines('<p>a</p>\n<script>alert(1)</script>\n<button onclick="x()">b</button>', 'script', [])).toEqual([2, 3]);
  });

  it('<noscript>の内容は表示される旨を警告する', () => {
    expect(codes('<noscript>JavaScriptを有効にしてください</noscript>', [])).toContain('noscript');
  });

  it('取り込んでいないCSSを参照する<link>を警告する(取り込んだCSSの<link>は警告しない)', () => {
    const html = '<link rel="stylesheet" href="style.css">\n<link rel="stylesheet" href="https://cdn.example.com/x.css">';
    expect(lines(html, 'stylesheet-missing')).toEqual([2]);
  });

  it('data URI以外の画像・メディアは警告し、data URIと#だけの参照は警告しない', () => {
    const html = [
      '<img src="a.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<img srcset="b.png 1x, data:image/png;base64,AAAA 2x">',
      '<video poster="p.jpg"></video>',
      '<iframe src="#"></iframe>',
    ].join('\n');
    expect(lines(html, 'external-resource', [])).toEqual([1, 3, 4]);
  });

  it('<style>・style属性・CSSファイル内の url(…)・@import を警告する', () => {
    const html = '<style>\nbody { background: url(bg.png); }\n</style>\n<p style="background:url(\'x.png\')">a</p>';
    expect(lines(html, 'external-resource', [])).toEqual([2, 4]);

    const css = { name: 'style.css', text: '@import "base.css";\n.a { background: url(a.png) }\n.b { background: url(data:image/svg+xml;base64,AAAA) }' };
    const found = lintHtml('<link rel="stylesheet" href="style.css">', [css]).find((w) => w.code === 'external-resource:style.css');
    expect(found?.lines).toEqual([1, 2]);
    expect(found?.message).toContain('style.css');
  });

  it('どの<link>にも参照されていないCSSは、追加して適用する旨を知らせる', () => {
    const result = lintHtml('<p>x</p>', [CSS]);
    expect(result.map((warning) => warning.code)).toEqual(['unreferenced-stylesheet:style.css']);
    expect(result[0]?.message).toContain('<head>の末尾に追加して適用');
  });
});
