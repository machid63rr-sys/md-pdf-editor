import { describe, expect, it } from 'vitest';
import { composeHtml, findStylesheet, stylesheetBaseName } from './htmlCompose';

const CSS = { name: 'style.css', text: 'p { color: red; }' };
const plain = { preview: false } as const;
const preview = { preview: true } as const;

describe('stylesheetBaseName', () => {
  it.each([
    ['style.css', 'style.css'],
    ['./css/style.css', 'style.css'],
    ['../assets/style.css?v=2#top', 'style.css'],
    ['C:\\site\\main.css', 'main.css'],
    ['%E6%97%A5%E6%9C%AC.css', '日本.css'],
    ['https://example.com/a/b.css', 'b.css'],
  ])('%s -> %s', (href, expected) => {
    expect(stylesheetBaseName(href)).toBe(expected);
  });
});

describe('findStylesheet', () => {
  it('ファイル名で突き合わせる(大文字小文字は区別しない・フォルダ名は無視する)', () => {
    expect(findStylesheet('css/STYLE.CSS', [CSS])).toBe(CSS);
    expect(findStylesheet('other.css', [CSS])).toBeUndefined();
  });
});

describe('composeHtml: CSSの埋め込み', () => {
  it('<head>内の<link>は、その位置へCSSを埋め込む(他の部分は変わらない)', () => {
    const source = '<!DOCTYPE html>\n<html>\n<head>\n  <title>t</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body><p>x</p></body>\n</html>';
    expect(composeHtml(source, [CSS], plain)).toBe(
      '<!DOCTYPE html>\n<html>\n<head>\n  <title>t</title>\n  <style>p { color: red; }</style>\n</head>\n<body><p>x</p></body>\n</html>',
    );
  });

  it('relの大文字小文字・複数指定、フォルダ付きのhrefでも一致する', () => {
    const source = '<head><link REL="Stylesheet preload" href="css/style.css?v=1"></head><body></body>';
    expect(composeHtml(source, [CSS], plain)).toBe('<head><style>p { color: red; }</style></head><body></body>');
  });

  it('参照されていないCSSは、</head>の直前へ追加する', () => {
    const source = '<head><title>t</title></head><body><p>x</p></body>';
    expect(composeHtml(source, [CSS], plain)).toBe('<head><title>t</title><style>p { color: red; }</style></head><body><p>x</p></body>');
  });

  it('<link>が<body>内にある場合も、CSSは<head>の末尾へ追加し、<link>は残す', () => {
    const source = '<head></head><body><link rel="stylesheet" href="style.css"><p>x</p></body>';
    const result = composeHtml(source, [CSS], plain);
    expect(result).toBe('<head><style>p { color: red; }</style></head><body><link rel="stylesheet" href="style.css"><p>x</p></body>');
  });

  it('</head>が省略されていても、本文の前へ追加する', () => {
    const source = '<title>t</title><p>x</p>';
    expect(composeHtml(source, [CSS], plain)).toBe('<title>t</title><style>p { color: red; }</style><p>x</p>');
  });

  it('html/head/bodyが無い断片でも、先頭に追加して適用される', () => {
    expect(composeHtml('<p>x</p>', [CSS], plain)).toBe('<style>p { color: red; }</style><p>x</p>');
  });

  it('同じCSSを参照する<link>が複数あっても、埋め込むのは1回', () => {
    const source = '<head><link rel=stylesheet href=style.css><link rel=stylesheet href=style.css></head>';
    const result = composeHtml(source, [CSS], plain);
    expect(result.match(/<style>/g)).toHaveLength(1);
  });

  it('CSSの中の</style は無害化される', () => {
    const result = composeHtml('<head></head>', [{ name: 'a.css', text: '/* </style><script>x</script> */' }], plain);
    expect(result).not.toContain('</style><script>');
  });

  it('CSSが無ければ、ソースは変わらない', () => {
    const source = '<!DOCTYPE html><title>t</title><p>x</p>';
    expect(composeHtml(source, [], plain)).toBe(source);
  });
});

describe('composeHtml: プレビュー用の安全対策', () => {
  it('headの先頭に、外部通信を禁じるCSPを加える', () => {
    const result = composeHtml('<!DOCTYPE html><html><head><title>t</title></head><body></body></html>', [], preview);
    expect(result).toMatch(/<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'[^"]*"><title>t<\/title>/);
    expect(result.startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it('CSPは、CSSの<style>より前に置かれる', () => {
    const result = composeHtml('<head></head>', [CSS], preview);
    expect(result.indexOf('Content-Security-Policy')).toBeLessThan(result.indexOf('<style>'));
  });

  it.each([
    ['<p>x</p>', '<meta'],
    ['<html><p>x</p></html>', '<html><meta'],
    ['<!DOCTYPE html><p>x</p>', '<!DOCTYPE html><meta'],
  ])('headが省略された文書(%s)でも、doctypeの前には入らず、本文の前に入る', (source, prefix) => {
    const result = composeHtml(source, [], preview);
    expect(result.startsWith(prefix)).toBe(true);
    expect(result).toContain('<p>x</p>');
  });

  it('headの中のメタリフレッシュは除く', () => {
    const result = composeHtml('<head><meta http-equiv="refresh" content="0;url=https://example.com"><title>t</title></head>', [], preview);
    expect(result).not.toContain('refresh');
    expect(result).toContain('<title>t</title>');
  });

  it('プレビュー用でなければ、CSPもメタリフレッシュの除去も行わない', () => {
    const source = '<head><meta http-equiv="refresh" content="5"></head>';
    expect(composeHtml(source, [], plain)).toBe(source);
  });
});
