import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareHtmlForPdf } from '../src/server/htmlDocument.js';
import { buildDocumentHtml } from '../src/server/markdownToHtml.js';
import { createPdfRenderer, type PdfRenderer } from '../src/server/pdf.js';
import { selfCheck } from '../src/server/selfCheck.js';

/*
 * 実Chromiumでの統合テスト。Chromium(CHROMIUM_PATH)と poppler-utils(pdffonts/pdfinfo/pdftotext)が必要。
 * Dockerのtestステージで実行する。無い環境では黙ってスキップせず、失敗させる。
 */
const css = readFileSync(new URL('../src/shared/document.css', import.meta.url), 'utf8');
const renderer: PdfRenderer = createPdfRenderer({
  chromiumPath: process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium',
  timeoutMs: 60_000,
});

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'md-pdf-editor-pdf-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const writePdf = (name: string, pdf: Buffer): string => {
  const path = join(workDir, name);
  writeFileSync(path, pdf);
  return path;
};
const poppler = (tool: string, ...args: string[]): string => execFileSync(tool, args, { encoding: 'utf8' });

const wideTable = (): string => {
  const header = `| ${Array.from({ length: 10 }, (_, i) => `列${i + 1}`).join(' | ')} |`;
  const delimiter = `| ${Array.from({ length: 10 }, () => '---').join(' | ')} |`;
  const row = (r: number) => `| ${Array.from({ length: 10 }, (_, c) => `行${r}-${c + 1} の説明文`).join(' | ')} |`;
  return [header, delimiter, ...Array.from({ length: 4 }, (_, r) => row(r + 1))].join('\n');
};

describe('PDF生成(実Chromium)', () => {
  it('日本語・絵文字・罫線・10列の表を含むMarkdownがPDFになる', async () => {
    const markdown = [
      '# 日本語の見出し ✓ → 🔧',
      '',
      '本文です。禁則処理（句読点、括弧）を確認します。',
      '',
      '```',
      'project/',
      '├─ src/',
      '│  └─ main.ts',
      '└─ README.md',
      '```',
      '',
      wideTable(),
    ].join('\n');

    const pdf = await renderer.render(buildDocumentHtml(markdown, css));
    const path = writePdf('basic.pdf', pdf);

    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(poppler('pdfinfo', path)).toMatch(/Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/);
    expect(poppler('pdffonts', path)).toContain('NotoSansCJKjp');
    const text = poppler('pdftotext', path, '-');
    expect(text).toContain('日本語の見出し');
    expect(text).toContain('禁則処理');
    expect(text).toContain('列10');
    expect(text).toContain('行4-10');
    // フッターのページ番号
    expect(text).toMatch(/1\s*\/\s*1/);
  });

  it('Markdownの相対パスの画像(assets)は、PDFに画像として入る。渡されていない画像は文字になる', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const markdown = '# 画像\n\n![図](img/a.png)\n\n![無い図](img/none.png)';
    const path = writePdf('md-assets.pdf', await renderer.render(buildDocumentHtml(markdown, css, { baseDir: 'docs', files: { 'docs/img/a.png': png } })));

    expect(poppler('pdfimages', '-list', path).split('\n').filter((line) => /^\s*\d+\s+\d+\s+image\b/.test(line))).toHaveLength(1);
    expect(poppler('pdftotext', path, '-')).toContain('[画像: 無い図](img/none.png)');
  });

  it('長い文書は複数ページになり、表の見出し行が各ページで繰り返される', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => `| ${i + 1} | データ${i + 1} |`).join('\n');
    const markdown = `# 長い表\n\n| 番号 | 内容 |\n| --- | --- |\n${rows}`;

    const path = writePdf('long.pdf', await renderer.render(buildDocumentHtml(markdown, css)));

    const pages = Number(/Pages:\s+(\d+)/.exec(poppler('pdfinfo', path))?.[1]);
    expect(pages).toBeGreaterThan(1);
    const secondPage = poppler('pdftotext', '-f', '2', '-l', '2', path, '-');
    expect(secondPage).toContain('番号');
    expect(secondPage).toContain('内容');
  });

  it('外部リソースへは通信しない(画像の参照先がローカルのサーバでも、アクセスが発生しない)', async () => {
    const requested: string[] = [];
    const probe: Server = createServer((req, res) => {
      requested.push(req.url ?? '');
      res.end();
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    try {
      // buildDocumentHtmlは外部画像を文字に置き換えるため、ここではレンダラ自身の遮断を見るよう生のHTMLを渡す
      const html = `<!doctype html><html><body><img src="http://127.0.0.1:${port}/img.png"><link rel="stylesheet" href="http://127.0.0.1:${port}/a.css"><p>本文</p></body></html>`;
      const pdf = await renderer.render(html);

      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(requested).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('スクリプトは実行されない', async () => {
    const html = '<!doctype html><html><body><p id="t">前</p><script>document.getElementById("t").textContent="実行された";</script></body></html>';
    const text = poppler('pdftotext', writePdf('script.pdf', await renderer.render(html)), '-');
    expect(text).toContain('前');
    expect(text).not.toContain('実行された');
  });

  it('存在しないChromiumを指定すると、PDFの生成に失敗として例外になる', async () => {
    const broken = createPdfRenderer({ chromiumPath: '/nonexistent/chromium', timeoutMs: 5_000 });
    await expect(broken.render('<p>x</p>')).rejects.toThrowError('PDFの生成に失敗しました');
    await expect(broken.chromiumVersion()).rejects.toThrowError('Chromiumを起動できません');
  });
});

describe('HTMLのPDF生成(実Chromium)', () => {
  // サーバと同じく、安全対策を加えたHTMLを、用紙サイズの指定を尊重して描画する
  const renderHtml = (html: string, name: string): Promise<string> =>
    renderer.render(prepareHtmlForPdf(html), { preferCssPageSize: true }).then((pdf) => writePdf(name, pdf));

  it('利用者のHTMLとCSS(日本語・色・表)が、そのままPDFになる(既定はA4)', async () => {
    const html =
      '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>案内</title><style>h1{color:#c00}td{border:1px solid #000}</style></head>' +
      '<body><h1>お知らせ</h1><p>本日は<b>休業</b>です。</p><table><tr><td>項目</td><td>内容</td></tr></table></body></html>';
    const path = await renderHtml(html, 'html-basic.pdf');

    expect(readFileSync(path).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(poppler('pdfinfo', path)).toMatch(/Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/);
    expect(poppler('pdffonts', path)).toContain('NotoSansCJKjp');
    const text = poppler('pdftotext', path, '-');
    expect(text).toContain('お知らせ');
    expect(text).toContain('休業');
    expect(text).toContain('項目');
    // Markdown用の共有CSS(.document)は、利用者のHTMLには適用されない
    expect(text).toMatch(/1\s*\/\s*1/);
  });

  it('CSSの @page で用紙サイズを指定すると、その大きさのPDFになる', async () => {
    const html = '<!DOCTYPE html><html><head><style>@page { size: A5 landscape; }</style></head><body><p>横向きのA5</p></body></html>';
    const info = poppler('pdfinfo', await renderHtml(html, 'html-a5.pdf'));
    // A5の横向き(210mm x 148mm)
    expect(info).toMatch(/Page size:\s+59\d(\.\d+)? x 4[12]\d(\.\d+)? pts \(A5\)/);
  });

  it('data URIの画像はPDFに表示される', async () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const path = await renderHtml(`<!DOCTYPE html><body><p>画像</p><img src="data:image/png;base64,${png}" width="80" height="80"></body>`, 'html-img.pdf');
    expect(poppler('pdfimages', '-list', path)).toMatch(/\bimage\b/);
  });

  it('外部リソースへは通信しない(画像・CSS・フォント・メタリフレッシュの参照先がローカルのサーバでも、アクセスが発生しない)', async () => {
    const requested: string[] = [];
    const probe: Server = createServer((req, res) => {
      requested.push(req.url ?? '');
      res.end();
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    try {
      const html =
        `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${origin}/refresh"><link rel="stylesheet" href="${origin}/a.css">` +
        `<style>@import url(${origin}/b.css); @font-face{font-family:x;src:url(${origin}/f.woff)} p{background:url(${origin}/bg.png);font-family:x}</style></head>` +
        `<body><img src="${origin}/img.png"><iframe src="${origin}/frame"></iframe><p>本文は残る</p></body></html>`;
      const path = await renderHtml(html, 'html-external.pdf');

      expect(requested).toEqual([]);
      // 遮断された移動先のエラーページではなく、利用者の文書がPDFになる
      expect(poppler('pdftotext', path, '-')).toContain('本文は残る');
    } finally {
      await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('スクリプトは実行されない(イベント属性も含む)', async () => {
    const html =
      '<!DOCTYPE html><body><p id="t">前</p><script>document.getElementById("t").textContent="実行された";</script>' +
      '<img src="x" onerror="document.getElementById(\'t\').textContent=\'実行された\'"></body>';
    const text = poppler('pdftotext', await renderHtml(html, 'html-script.pdf'), '-');
    expect(text).toContain('前');
    expect(text).not.toContain('実行された');
  });
});

describe('起動時セルフチェック', () => {
  it('Chromiumの版を返す', async () => {
    const { chromium } = await selfCheck(renderer, css);
    expect(chromium).toMatch(/Chrom(e|ium)\/\d+/);
  });

  it('レンダラがPDFを返さなければ例外にする', async () => {
    const broken: PdfRenderer = {
      chromiumVersion: () => Promise.resolve('x'),
      render: () => Promise.resolve(Buffer.from('not a pdf')),
    };
    await expect(selfCheck(broken, css)).rejects.toThrowError('生成物がPDFではありません');
  });
});
