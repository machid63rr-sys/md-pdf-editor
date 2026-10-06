import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareHtmlForPdf } from '../src/server/htmlDocument.js';
import { buildDocumentHtml, extractMermaidSources, type DiagramMap } from '../src/server/markdownToHtml.js';
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
  mermaidScript: readFileSync(new URL('../node_modules/mermaid/dist/mermaid.min.js', import.meta.url), 'utf8'),
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
    const broken = createPdfRenderer({ chromiumPath: '/nonexistent/chromium', timeoutMs: 5_000, mermaidScript: '' });
    await expect(broken.render('<p>x</p>')).rejects.toThrowError('PDFの生成に失敗しました');
    await expect(broken.chromiumVersion()).rejects.toThrowError('Chromiumを起動できません');
  });
});

// 1ページ目を画像にして、条件に合う色の点がいくつあるかを数える(pdftoppmが出力するP6形式のPPMを読む)
function countPixels(pdfPath: string, matches: (red: number, green: number, blue: number) => boolean): number {
  const root = `${pdfPath}.page`;
  execFileSync('pdftoppm', ['-r', '80', '-f', '1', '-l', '1', '-singlefile', pdfPath, root]);
  const ppm = readFileSync(`${root}.ppm`);
  // ヘッダ: "P6\n<幅> <高さ>\n255\n"。その後ろが画素(R,G,Bの順)
  const header = /^P6\s+\d+\s+\d+\s+255\s/.exec(ppm.subarray(0, 64).toString('latin1'));
  if (header === null) {
    throw new Error('PPMを読めません');
  }
  let count = 0;
  for (let offset = header[0].length; offset + 2 < ppm.length; offset += 3) {
    if (matches(ppm[offset] ?? 0, ppm[offset + 1] ?? 0, ppm[offset + 2] ?? 0)) {
      count += 1;
    }
  }
  return count;
}

// 図の箱の塗り(薄い紫 #ececff)。コードブロックの背景(薄い灰色 #f3f4f6)とは、青みの差で見分ける
const isDiagramFill = (r: number, g: number, b: number): boolean => b > 240 && b - r > 12 && b - g > 12;

// 単色のPNG(幅・高さ・色を指定)。画像を、どの大きさで表示したかを、PDFの画素で測るために使う
function solidPng(width: number, height: number, [red, green, blue]: [number, number, number]): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
  });
  const crc32 = (data: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of data) {
      c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8bit・RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [red, green, blue]).flat())]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

describe('Markdownの中の<img>タグ(エディタで大きさを変えた画像)(実Chromium)', () => {
  const red = solidPng(200, 100, [220, 20, 20]);
  const isRed = (r: number, g: number, b: number): boolean => r > 180 && g < 80 && b < 80;
  // 80dpiで1ページ目を画像にしたときの、1CSSピクセルあたりの画素数: 80 / 96
  const pixelsPerCssPx = 80 / 96;

  const redPixelsOf = async (name: string, markdown: string): Promise<{ path: string; red: number }> => {
    const path = writePdf(name, await renderer.render(buildDocumentHtml(markdown, css)));
    return { path, red: countPixels(path, isRed) };
  };

  it('大きさ(width・height)を指定した<img>は、PDFで、画像として、その大きさで表示される(タグの文字は出ない)', async () => {
    const { path, red: area } = await redPixelsOf('img-tag.pdf', `# 画像\n\n<img src="${red}" width="300" height="150" />\n\n本文`);

    expect(poppler('pdfimages', '-list', path).split('\n').filter((line) => /^\s*\d+\s+\d+\s+image\b/.test(line))).toHaveLength(1);
    const text = poppler('pdftotext', path, '-');
    expect(text).not.toContain('<img');
    expect(text).not.toContain('base64');
    expect(text).toContain('本文');
    // 300x150(CSSピクセル)の面積(±8%)
    const expected = 300 * 150 * pixelsPerCssPx ** 2;
    expect(area).toBeGreaterThan(expected * 0.92);
    expect(area).toBeLessThan(expected * 1.08);
  });

  it('大きさを指定しない<img>は、画像そのものの大きさ(200x100)で表示される', async () => {
    const { red: area } = await redPixelsOf('img-tag-natural.pdf', `<img src="${red}">`);
    const expected = 200 * 100 * pixelsPerCssPx ** 2;
    expect(area).toBeGreaterThan(expected * 0.92);
    expect(area).toBeLessThan(expected * 1.08);
  });

  it('ページの幅を超える大きさを指定しても、はみ出さず、縦横比(2:1)を保って縮められる', async () => {
    const { red: area } = await redPixelsOf('img-tag-wide.pdf', `<img src="${red}" width="2000" height="1000" />`);
    // 本文の幅(170mm = 約642CSSピクセル)に収まり、高さは、画像の縦横比から決まる(約321)。引き伸ばされた比率(2:1ではない)にはならない
    const width = 170 / 25.4 * 96;
    const expected = width * (width / 2) * pixelsPerCssPx ** 2;
    expect(area).toBeGreaterThan(expected * 0.92);
    expect(area).toBeLessThan(expected * 1.08);
  });

  it('画像の記法 ![]() と同じ大きさ・同じ見た目になる(<img>は、大きさの指定を加えただけ)', async () => {
    const markdownImage = await redPixelsOf('img-md.pdf', `![](${red})`);
    const tag = await redPixelsOf('img-tag-same.pdf', `<img src="${red}">`);
    expect(tag.red).toBe(markdownImage.red);
  });
});

describe('コードの色分け(実Chromium)', () => {
  // キーワードの色(#c22b3d)に近い、赤い点。見出し・本文・背景(灰色)・コードの文字色(黒に近い)には現れない色
  const isKeywordRed = (r: number, g: number, b: number): boolean => r > 150 && g < 100 && b < 110;

  it('言語名のあるコードブロックは、PDFで色が付く。言語名の無いコードブロックは、色が付かない', async () => {
    const code = 'def greet(name):\n    return "こんにちは"\n';
    const colored = writePdf('code-colored.pdf', await renderer.render(buildDocumentHtml('```python\n' + code + '```', css)));
    const plain = writePdf('code-plain.pdf', await renderer.render(buildDocumentHtml('```\n' + code + '```', css)));

    expect(countPixels(colored, isKeywordRed)).toBeGreaterThan(20);
    expect(countPixels(plain, isKeywordRed)).toBe(0);
    // 色分けしても、コードの文字は、抽出できる(フォントごとに分かれて、順序は入れ替わりうる)
    const text = poppler('pdftotext', colored, '-');
    expect(text).toContain('def greet(name):');
    expect(text).toContain('こんにちは');
  });

  it.each(['javascript', 'bash', 'sql', 'java', 'go', 'rust', 'ruby', 'php', 'kotlin', 'html', 'css', 'yaml'])(
    '%s のコードブロックも、PDFで色が付く',
    async (language) => {
      const code: Record<string, string> = {
        javascript: 'const x = 1;\nfunction f() { return x; }',
        bash: 'if [ -f a ]; then echo "hi"; fi',
        sql: 'SELECT id FROM users WHERE id = 1;',
        java: 'public class A { private int x = 1; }',
        go: 'func main() { var x int = 1 }',
        rust: 'fn main() { let x: i32 = 1; }',
        ruby: 'def hello\n  puts "hi"\nend',
        php: '<?php function f() { return 1; }',
        kotlin: 'fun main() { val x = 1 }',
        html: '<div class="a">x</div>',
        css: '@media print { .a { color: red; } }',
        yaml: 'key: value\nlist:\n  - 1',
      };
      const path = writePdf(`code-${language}.pdf`, await renderer.render(buildDocumentHtml('```' + language + '\n' + code[language] + '\n```', css)));
      // 色が付いた点があること(キーワード・文字列・数値などの、赤・青・紫・緑・橙のいずれか)
      const colored = countPixels(path, (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 90);
      expect(colored).toBeGreaterThan(20);
    },
  );
});

describe('Mermaidの図(実Chromium)', () => {
  const flow = 'graph TD\n  A[開始] --> B{判定}\n  B -->|はい| C[処理]\n  B -->|いいえ| D[終了]';

  const diagramsOf = async (markdown: string): Promise<DiagramMap> => {
    const sources = extractMermaidSources(markdown);
    const drawn = await renderer.drawDiagrams(sources);
    return new Map(sources.map((source, index) => [source, drawn[index] as NonNullable<(typeof drawn)[number]>]));
  };

  it('図のコードをSVGにする。結果は、渡した順に返る', async () => {
    const [flowchart, sequence, pie] = await renderer.drawDiagrams([flow, 'sequenceDiagram\n  Alice->>Bob: こんにちは', 'pie title ペット\n  "犬" : 3\n  "猫" : 5']);
    for (const outcome of [flowchart, sequence, pie]) {
      expect(outcome?.ok).toBe(true);
    }
    expect(flowchart?.ok === true && flowchart.svg).toContain('開始');
    expect(sequence?.ok === true && sequence.svg).toContain('Alice');
    expect(pie?.ok === true && pie.svg).toContain('犬');
  });

  it('描けない図(構文の誤り・図の種類が不明)は、理由つきの失敗になり、ほかの図は描かれる', async () => {
    const results = await renderer.drawDiagrams([flow, 'graph TD\n  A[ --> B', 'これは図ではありません', 'pie\n  "a" : 1']);
    expect(results.map((result) => result.ok)).toEqual([true, false, false, true]);
    const failures = results.flatMap((result) => (result.ok ? [] : [result.message]));
    expect(failures).toHaveLength(2);
    expect(failures.every((message) => message.length > 0 && !message.includes('\n'))).toBe(true);
  });

  it('図が無ければ、何も起動せず空の結果を返す', async () => {
    expect(await renderer.drawDiagrams([])).toEqual([]);
  });

  it('図の文字に含まれるHTML・スクリプト・リンクは、実行される形では出力されない', async () => {
    const [outcome] = await renderer.drawDiagrams([
      'graph TD\n  A["<img src=x onerror=alert(1)>文字<script>alert(2)</script>"] --> B\n  click A href "javascript:alert(3)"\n  click B call alert(4)',
    ]);
    expect(outcome?.ok).toBe(true);
    const svg = outcome?.ok === true ? outcome.svg : '';
    // <img>の文字は、無害な形(onerror等の属性なし)で残ることがある。実行される属性・スクリプト・リンクが無いことを確かめる
    expect(svg).not.toMatch(/<script|onerror=|javascript:|onclick=|onload=/i);
  });

  it('図の中から、安全設定を緩めることはできない(initディレクティブでsecurityLevelを変えても、スクリプトは出力されない)', async () => {
    const [outcome] = await renderer.drawDiagrams([
      '%%{init: {"securityLevel": "loose"}}%%\ngraph TD\n  A["<img src=x onerror=alert(1)>"] --> B\n  click A href "javascript:alert(3)"',
    ]);
    const svg = outcome?.ok === true ? outcome.svg : '';
    expect(svg).not.toMatch(/onerror=|javascript:/i);
  });

  it('図の描画では、外部へ通信しない', async () => {
    const requested: string[] = [];
    const probe: Server = createServer((req, res) => {
      requested.push(req.url ?? '');
      res.end();
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    try {
      await renderer.drawDiagrams([`graph TD\n  A["<img src='http://127.0.0.1:${port}/x.png'>"] --> B\n  A --> C["<a href='http://127.0.0.1:${port}/y'>y</a>"]`]);
      expect(requested).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('Markdownの図は、PDFに入る(日本語の文字も、図の中に抽出できる)。コードはPDFに出ない', async () => {
    const markdown = `# 図のある文書\n\n本文です。\n\n\`\`\`mermaid\n${flow}\n\`\`\`\n\n続きの文です。`;
    const path = writePdf('diagram.pdf', await renderer.render(buildDocumentHtml(markdown, css, undefined, await diagramsOf(markdown))));

    const text = poppler('pdftotext', path, '-');
    for (const label of ['開始', '判定', '処理', '終了', 'はい', 'いいえ', '続きの文です']) {
      expect(text, label).toContain(label);
    }
    expect(text).not.toContain('graph TD');
    expect(poppler('pdffonts', path)).toContain('NotoSansCJKjp');
    // 図の中の色(薄い紫の箱)が、実際に描かれている
    expect(countPixels(path, isDiagramFill)).toBeGreaterThan(500);
  });

  it('表示の選択: 図のみはコードがPDFに出ず、コードのみは図が出ず、両方は両方が出る', async () => {
    const pdfOf = async (meta: string): Promise<string> => {
      const markdown = `\`\`\`mermaid${meta}\n${flow}\n\`\`\``;
      return writePdf(`diagram-view${meta.replace(/\W/g, '')}.pdf`, await renderer.render(buildDocumentHtml(markdown, css, undefined, await diagramsOf(markdown))));
    };
    const diagramPixels = (path: string): number => countPixels(path, isDiagramFill);

    const diagramOnly = await pdfOf('');
    expect(poppler('pdftotext', diagramOnly, '-')).not.toContain('graph TD');
    expect(diagramPixels(diagramOnly)).toBeGreaterThan(500);

    const codeOnly = await pdfOf(' show=code');
    expect(poppler('pdftotext', codeOnly, '-')).toContain('graph TD');
    expect(diagramPixels(codeOnly)).toBe(0);

    const both = await pdfOf(' show=both');
    expect(poppler('pdftotext', both, '-')).toContain('graph TD');
    expect(diagramPixels(both)).toBeGreaterThan(500);
  });

  it('描けなかった図は、コードと理由がPDFに入り、PDFの生成は成功する', async () => {
    const markdown = '# 誤った図\n\n```mermaid\ngraph TD\n  A[ --> B\n```';
    const path = writePdf('diagram-broken.pdf', await renderer.render(buildDocumentHtml(markdown, css, undefined, await diagramsOf(markdown))));

    const text = poppler('pdftotext', path, '-');
    expect(text).toContain('Mermaidの図を描画できなかったため、コードのまま表示します');
    expect(text).toContain('graph TD');
  });

  it('縦長の図は、1ページに収まる大きさに縮めて表示される', async () => {
    const steps = Array.from({ length: 40 }, (_, index) => `  S${index}[Step${index}] --> S${index + 1}[Step${index + 1}]`).join('\n');
    const markdown = `# 長い図\n\n\`\`\`mermaid\ngraph TD\n${steps}\n\`\`\``;
    const path = writePdf('diagram-tall.pdf', await renderer.render(buildDocumentHtml(markdown, css, undefined, await diagramsOf(markdown))));

    // 縮めて描かれた小さな文字は、1つの語として抽出されない場合があるため、図が入っていることだけを確かめる
    expect(poppler('pdftotext', path, '-')).toContain('Step');
    expect(Number(/Pages:\s+(\d+)/.exec(poppler('pdfinfo', path))?.[1])).toBe(1);
  });

  it('JS無効のままPDFが作られる(図を作るためにJSを有効にするのは、図の描画用のページだけ)', async () => {
    const html = '<!doctype html><html><body><p id="t">前</p><script>document.getElementById("t").textContent="実行された";</script></body></html>';
    await renderer.drawDiagrams([flow]);
    const text = poppler('pdftotext', writePdf('script-after-diagram.pdf', await renderer.render(html)), '-');
    expect(text).toContain('前');
    expect(text).not.toContain('実行された');
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
      drawDiagrams: () => Promise.resolve([]),
    };
    await expect(selfCheck(broken, css)).rejects.toThrowError('生成物がPDFではありません');
  });

  it('Mermaidの図を描画できなければ例外にする', async () => {
    const broken: PdfRenderer = {
      chromiumVersion: () => Promise.resolve('x'),
      render: () => Promise.resolve(Buffer.from('%PDF-1.7')),
      drawDiagrams: () => Promise.resolve([{ ok: false, message: 'Mermaidが読み込めません' }]),
    };
    await expect(selfCheck(broken, css)).rejects.toThrowError('Mermaidの図を描画できません (Mermaidが読み込めません)');
  });
});
