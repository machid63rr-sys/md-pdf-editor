import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type ElementHandle, type Frame, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { createPdfRenderer } from '../src/server/pdf.js';

/*
 * 画面全体の結合テスト。ビルド済みクライアント(dist/client)を実サーバ・実Chromiumで動かし、
 * 「取り込み → 書式付き編集 → Markdownタブ → 出力」を操作する。
 * ヘッドレスではネイティブのフォルダ選択ダイアログを操作できないため、ダイアログ(showDirectoryPicker)だけを
 * ブラウザ標準のオリジン私有ファイルシステム(OPFS)のハンドルを返す関数に差し替える。
 * ファイルの存在確認・書き込み・上書きは、本物のFile System Access APIで行われる。
 * 事前に `npm run build` が必要(無ければ、わかりやすいメッセージで失敗する)。
 * 環境変数 E2E_SCREENSHOT_DIR を指定すると、各画面のスクリーンショットを保存する。
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const clientDir = join(root, 'dist/client');
const css = readFileSync(join(root, 'src/shared/document.css'), 'utf8');
const screenshotDir = process.env['E2E_SCREENSHOT_DIR'];

let browser: Browser;
let server: Server;
let baseUrl: string;
let page: Page;
const consoleErrors: string[] = [];

beforeAll(async () => {
  if (!existsSync(join(clientDir, 'index.html'))) {
    throw new Error('dist/client がありません。先に `npm run build` を実行してください。');
  }
  const renderer = createPdfRenderer({ chromiumPath: process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium', timeoutMs: 60_000 });
  const app = createApp({ maxMarkdownBytes: 5 * 1024 * 1024, renderer, css, clientDir, chromiumVersion: 'e2e' });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await puppeteer.launch({
    executablePath: process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    // ロケール未設定(Cロケール)のコンテナでは、Chromiumが日本語のファイル名を保存できず「download」になる。
    // 利用者のブラウザ(Windows等)では起きないため、検証用のChromiumだけUTF-8ロケールで起動する
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  });
  if (screenshotDir !== undefined) {
    mkdirSync(screenshotDir, { recursive: true });
  }
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(async () => {
  page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 1000 });
  consoleErrors.length = 0;
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  // フォルダ選択ダイアログの代わりに、OPFSのルートを「選ばれたフォルダ」として返す(中身は毎回空にする)
  await page.evaluateOnNewDocument(() => {
    window.showDirectoryPicker = async () => {
      const dir = await navigator.storage.getDirectory();
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
        await dir.removeEntry(name, { recursive: true });
      }
      return dir;
    };
  });
  page.on('dialog', (dialog) => void dialog.accept());
});

const shot = async (name: string): Promise<void> => {
  if (screenshotDir !== undefined) {
    await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true });
  }
};

const SAMPLE = [
  '# 取扱説明書',
  '',
  '画面に <エラー一覧表> と表示されます。型は `List<string>` のようにも書きます。',
  '',
  '| 項目 | 説明 |',
  '| --- | --- |',
  '| A | 最初の項目 |',
  '',
  '```python',
  'print("こんにちは")',
  '```',
].join('\n');

// textareaへ長い文字列を入れるには、1文字ずつ入力せず値を直接設定してinputイベントを発火させる
async function setPasted(markdown: string): Promise<void> {
  await page.goto(baseUrl);
  await page.waitForSelector('#paste-area');
  await page.$eval(
    '#paste-area',
    (element, value) => {
      const area = element as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(area, value);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    },
    markdown,
  );
}

const clickButton = async (label: string): Promise<void> => {
  const handle = await page.evaluateHandle((text) => {
    return [...document.querySelectorAll('button')].find((button) => button.textContent?.includes(text)) ?? null;
  }, label);
  const element = handle.asElement();
  if (element === null) {
    throw new Error(`ボタン「${label}」が見つかりません`);
  }
  await (element as unknown as { click(): Promise<void> }).click();
};

const sourceValue = (): Promise<string> =>
  page.$eval('textarea[aria-label="Markdown"]', (element) => (element as HTMLTextAreaElement).value);

async function loadMarkdown(markdown: string): Promise<void> {
  await setPasted(markdown);
  await shot('1-import');
  await clickButton('貼り付けた内容を読み込む');
}

async function openEditor(markdown: string): Promise<void> {
  await loadMarkdown(markdown);
  await page.waitForSelector('.md-editor-content');
}

describe('画面操作(実ブラウザ)', () => {
  it('取り込むと、書式付きプレビューに見出し・表・コードが描画され、解釈エラーにならない', async () => {
    await openEditor(SAMPLE);
    await page.waitForFunction(() => document.querySelector('.md-editor-content h1') !== null);

    const text = await page.$eval('.md-editor-content', (element) => (element as HTMLElement).innerText);
    expect(text).toContain('取扱説明書');
    expect(text).toContain('<エラー一覧表>');
    expect(text).toContain('List<string>');
    expect(text).not.toContain('\\<');
    expect(await page.$('.md-editor-content table')).not.toBeNull();
    expect(await page.$('[role="alert"]')).toBeNull();
    await shot('2-edit-rich');
    expect(consoleErrors).toEqual([]);
  });

  it('編集しなければMarkdownは取り込んだままで、Markdownタブにそのまま表示される', async () => {
    await openEditor(SAMPLE);
    await clickButton('Markdown');
    expect(await sourceValue()).toBe(SAMPLE);
  });

  it('書式付きで編集すると、山括弧とインラインコードが壊れずにMarkdownへ反映される', async () => {
    await openEditor(SAMPLE);
    await page.click('.md-editor-content h1');
    await page.keyboard.press('End');
    await page.keyboard.type('(第2版)');
    await clickButton('Markdown');

    const edited = await sourceValue();
    expect(edited).toContain('# 取扱説明書(第2版)');
    expect(edited).toContain('<エラー一覧表>');
    expect(edited).toContain('`List<string>`');
    expect(edited).not.toContain('\\<');
    expect(edited).toContain('```python');
    expect(edited).toMatch(/\| 項目\s*\| 説明\s*\|/);
    await shot('3-edit-source');
  });

  it('Markdownタブでの編集が、書式付きプレビューへ反映される', async () => {
    await openEditor(SAMPLE);
    await clickButton('Markdown');
    await page.$eval('textarea[aria-label="Markdown"]', (element) => {
      const area = element as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(area, `${area.value}\n\n## 追記した見出し`);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickButton('プレビュー');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.md-editor-content h2')].some((h) => h.textContent === '追記した見出し'),
    );
  });

  it('脚注を含むMarkdownは、書式付きでは扱えない旨を表示してMarkdownタブへ切り替わる(黙って壊さない)', async () => {
    await loadMarkdown('本文[^1]\n\n[^1]: 脚注');
    await page.waitForSelector('[role="alert"]');
    const alertText = await page.$eval('[role="alert"]', (element) => (element as HTMLElement).innerText);
    expect(alertText).toContain('書式付きエディタで扱えない記法');
    expect(await sourceValue()).toBe('本文[^1]\n\n[^1]: 脚注');
    await shot('4-parse-error');
  });

  it('生HTML・外部画像・front matterの警告が表示される', async () => {
    await openEditor('---\ntitle: T\n---\n\n改行<br>です\n\n![図](https://example.com/a.png)');
    await page.waitForSelector('.warning-list');
    const warnings = await page.$eval('.warning-list', (element) => (element as HTMLElement).innerText);
    expect(warnings).toContain('front matter');
    expect(warnings).toContain('HTMLタグ');
    expect(warnings).toContain('表示できない画像');
    await shot('5-warnings');
  });

  describe('出力', () => {
    const outputButton = (): Promise<boolean> =>
      page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('選んだフォルダへMDとPDFを出力'));
        return button?.disabled ?? true;
      });

    const readOutputs = (): Promise<{ names: string[]; markdown: string; pdfHeader: string; pdfSize: number }> =>
      page.evaluate(async () => {
        const dir = await navigator.storage.getDirectory();
        const names: string[] = [];
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          names.push(name);
        }
        names.sort();
        const mdFile = await (await dir.getFileHandle('manual.md')).getFile();
        const pdfFile = await (await dir.getFileHandle('manual.pdf')).getFile();
        const header = new TextDecoder('latin1').decode((await pdfFile.arrayBuffer()).slice(0, 5));
        return { names, markdown: await mdFile.text(), pdfHeader: header, pdfSize: pdfFile.size };
      });

    it('フォルダを選ぶまで出力ボタンは無効。選ぶとMDとPDFが同じ名前で書き込まれる', async () => {
      await openEditor(SAMPLE);
      await page.$eval('#base-name', (element) => {
        const input = element as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, 'manual');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(await outputButton()).toBe(true);

      await clickButton('出力先フォルダを選択');
      await page.waitForFunction(() => !([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('選んだフォルダへMDとPDFを出力'))?.disabled ?? true));
      await clickButton('選んだフォルダへMDとPDFを出力');
      await page.waitForSelector('.notice-success', { timeout: 60_000 });

      const status = await page.$eval('.notice-success', (element) => (element as HTMLElement).innerText);
      expect(status).toContain('manual.md');
      expect(status).toContain('manual.pdf');
      const outputs = await readOutputs();
      expect(outputs.names).toEqual(['manual.md', 'manual.pdf']);
      expect(outputs.markdown).toBe(SAMPLE);
      expect(outputs.pdfHeader).toBe('%PDF-');
      expect(outputs.pdfSize).toBeGreaterThan(1000);
      await shot('6-output-success');
      expect(consoleErrors).toEqual([]);
    });

    it('ファイル名に使えない文字があると、理由を表示して出力できない', async () => {
      await openEditor(SAMPLE);
      await page.$eval('#base-name', (element) => {
        const input = element as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, 'a/b');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForSelector('.field-error');
      const message = await page.$eval('.field-error', (element) => (element as HTMLElement).innerText);
      expect(message).toContain('使えません');
      expect(await outputButton()).toBe(true);
    });
  });

  it('showDirectoryPickerが無いブラウザでは、出力ボタンを無効にして理由を表示する', async () => {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
    });
    await openEditor(SAMPLE);
    const reason = await page.$eval('.field-error', (element) => (element as HTMLElement).innerText);
    expect(reason).toContain('Chrome または Edge');
  });

  describe('保存するファイルの選択(チェックボックス)', () => {
    const state = (): Promise<{
      nameDisabled: boolean;
      suffix: string;
      folder: boolean;
      primary: string;
      primaryDisabled: boolean;
      download: boolean;
      text: string;
    }> =>
      page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')];
        const find = (text: string) => buttons.find((b) => b.textContent?.includes(text));
        const primary = document.querySelector('.actions .button-primary') as HTMLButtonElement;
        return {
          nameDisabled: (document.getElementById('base-name') as HTMLInputElement).disabled,
          suffix: (document.querySelector('.field-suffix') as HTMLElement).innerText,
          folder: find('出力先フォルダを選択')?.disabled ?? true,
          primary: primary.textContent ?? '',
          primaryDisabled: primary.disabled,
          download: find('ダウンロードで保存')?.disabled ?? true,
          text: (document.querySelector('.output-panel') as HTMLElement).innerText,
        };
      });

    // ブラウザ内の保存先(OPFS)は、テストをまたいで残るため、毎回空にして「保存されていないこと」を検証できるようにする
    beforeEach(async () => {
      await page.goto(baseUrl);
      await page.evaluate(async () => {
        const dir = await navigator.storage.getDirectory();
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          await dir.removeEntry(name, { recursive: true });
        }
      });
    });

    const setChecked = async (label: string, checked: boolean): Promise<void> => {
      await page.evaluate(
        (text, value) => {
          const input = [...document.querySelectorAll('.file-select label')]
            .find((l) => l.textContent?.includes(text))
            ?.querySelector('input') as HTMLInputElement;
          if (input.checked !== value) {
            input.click();
          }
        },
        label,
        checked,
      );
    };

    const setBaseName = (value: string): Promise<void> =>
      page.$eval(
        '#base-name',
        (element, name) => {
          const input = element as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(input, name);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        },
        value,
      );

    const savedNames = (): Promise<string[]> =>
      page.evaluate(async () => {
        const dir = await navigator.storage.getDirectory();
        const names: string[] = [];
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          names.push(name);
        }
        return names.sort();
      });

    const savedFile = (name: string): Promise<{ text: string; header: string } | null> =>
      page.evaluate(async (fileName) => {
        const dir = await navigator.storage.getDirectory();
        try {
          const file = await (await dir.getFileHandle(fileName)).getFile();
          return { text: await file.text(), header: new TextDecoder('latin1').decode((await file.arrayBuffer()).slice(0, 5)) };
        } catch {
          return null;
        }
      }, name);

    // フォルダを選び、出力ボタンが有効になってから押す
    const chooseFolderAndOutput = async (label: string): Promise<void> => {
      await clickButton('出力先フォルダを選択');
      await page.waitForFunction(
        (text) => !([...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))?.disabled ?? true),
        {},
        label,
      );
      await clickButton(label);
      await page.waitForSelector('.notice-success', { timeout: 60_000 });
    };

    it('初期状態は両方チェック。ファイル名を編集でき、フォルダを選んでまとめて出力する', async () => {
      await openEditor(SAMPLE);
      const initial = await state();
      expect(initial.nameDisabled).toBe(false);
      expect(initial.suffix).toBe('.md / .pdf');
      expect(initial.folder).toBe(false);
      expect(initial.primary).toBe('選んだフォルダへMDとPDFを出力');
      expect(initial.download).toBe(false);
      await shot('7-select-both');
    });

    it.each([
      ['Markdown (.md)', '.pdf', '選んだフォルダへPDFを出力'],
      ['PDF (.pdf)', '.md', '選んだフォルダへMDを出力'],
    ])('%s を外しても(片方だけ保存)、ファイル名を編集でき、フォルダ選択とダウンロードも使える', async (unchecked, suffix, expectedLabel) => {
      await openEditor(SAMPLE);
      await setChecked(unchecked, false);

      const single = await state();
      expect(single.nameDisabled).toBe(false);
      expect(single.suffix).toBe(suffix);
      expect(single.folder).toBe(false);
      expect(single.download).toBe(false);
      expect(single.primary).toBe(expectedLabel);
      // フォルダを選ぶまでは、出力できない
      expect(single.primaryDisabled).toBe(true);
      expect(single.text).not.toContain('名前を付けて保存');
      await shot('8-select-single');

      // 両方に戻すと、元の状態に戻る
      await setChecked(unchecked, true);
      const both = await state();
      expect(both.suffix).toBe('.md / .pdf');
      expect(both.primary).toBe('選んだフォルダへMDとPDFを出力');
    });

    it('両方外すと、保存系のボタンはすべて無効になり、選ぶよう促す', async () => {
      await openEditor(SAMPLE);
      await setChecked('Markdown (.md)', false);
      await setChecked('PDF (.pdf)', false);

      const none = await state();
      expect(none.nameDisabled).toBe(true);
      expect(none.folder).toBe(true);
      expect(none.primaryDisabled).toBe(true);
      expect(none.download).toBe(true);
      expect(none.text).toContain('保存するファイルを1つ以上選んでください');
    });

    it('PDFだけ保存: ファイル名を決めてフォルダを選ぶと、「<名前>.pdf」だけが書き込まれる', async () => {
      await openEditor(SAMPLE);
      await setChecked('Markdown (.md)', false);
      await setBaseName('手順書');
      await chooseFolderAndOutput('選んだフォルダへPDFを出力');

      const status = await page.$eval('.notice-success', (element) => (element as HTMLElement).innerText);
      expect(status).toContain('手順書.pdf');
      expect(status).not.toContain('手順書.md');
      expect(await savedNames()).toEqual(['手順書.pdf']);
      expect((await savedFile('手順書.pdf'))?.header).toBe('%PDF-');
      await shot('9-save-pdf-only');
      expect(consoleErrors).toEqual([]);
    });

    it('Markdownだけ保存: ファイル名を決めてフォルダを選ぶと、編集した内容の「<名前>.md」だけが書き込まれる', async () => {
      await openEditor(SAMPLE);
      await setChecked('PDF (.pdf)', false);
      await chooseFolderAndOutput('選んだフォルダへMDを出力');

      expect(await savedNames()).toEqual(['document.md']);
      expect((await savedFile('document.md'))?.text).toBe(SAMPLE);
      expect(consoleErrors).toEqual([]);
    });

    it('片方だけ保存でも、ファイル名に使えない文字があると、理由を表示して出力できない', async () => {
      await openEditor(SAMPLE);
      await setChecked('PDF (.pdf)', false);
      await setBaseName('a/b');
      await page.waitForSelector('.field-error');

      const invalid = await state();
      expect(invalid.text).toContain('使えません');
      expect(invalid.primaryDisabled).toBe(true);
      expect(invalid.download).toBe(true);
    });

    it('片方だけ保存でもダウンロードできる: 選んだファイルだけが、入力した名前で保存される', async () => {
      const downloads = mkdtempSync(join(tmpdir(), 'md-pdf-editor-single-'));
      const client = await page.createCDPSession();
      await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
      await openEditor(SAMPLE);
      await setChecked('PDF (.pdf)', false);
      await setBaseName('メモ');

      await clickButton('ダウンロードで保存');
      await page.waitForSelector('.notice-success');
      const deadline = Date.now() + 30_000;
      while (!readdirSync(downloads).includes('メモ.md') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(readdirSync(downloads).sort()).toEqual(['メモ.md']);
      expect(readFileSync(join(downloads, 'メモ.md'), 'utf8')).toBe(SAMPLE);
      rmSync(downloads, { recursive: true, force: true });
    });
  });

  describe('ダウンロードで保存', () => {
    let downloadDir: string;

    beforeEach(() => {
      downloadDir = mkdtempSync(join(tmpdir(), 'md-pdf-editor-download-'));
    });

    const allowDownloads = async (): Promise<void> => {
      const client = await page.createCDPSession();
      await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    };

    const waitForFiles = async (names: string[]): Promise<void> => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const present = readdirSync(downloadDir);
        if (names.every((name) => present.includes(name) && statSync(join(downloadDir, name)).size > 0)) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`ダウンロードされませんでした: ${names.join(', ')} (実際: ${readdirSync(downloadDir).join(', ')})`);
    };

    it('フォルダを選ばなくても、MDとPDFの両方がダウンロードされる(内容も正しい)', async () => {
      await allowDownloads();
      await openEditor(SAMPLE);
      await page.$eval('#base-name', (element) => {
        const input = element as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, '手順書');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      await clickButton('ダウンロードで保存');
      await waitForFiles(['手順書.md', '手順書.pdf']);

      expect(readFileSync(join(downloadDir, '手順書.md'), 'utf8')).toBe(SAMPLE);
      expect(readFileSync(join(downloadDir, '手順書.pdf')).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const status = await page.$eval('.notice-success', (element) => (element as HTMLElement).innerText);
      expect(status).toContain('手順書.md');
      expect(status).toContain('手順書.pdf');
      rmSync(downloadDir, { recursive: true, force: true });
    });

    it('フォルダ選択に対応していないブラウザでも、ダウンロードで保存できる', async () => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
      });
      await allowDownloads();
      await openEditor(SAMPLE);
      const reason = await page.$eval('.field-error', (element) => (element as HTMLElement).innerText);
      expect(reason).toContain('ダウンロードで保存');

      await clickButton('ダウンロードで保存');
      await waitForFiles(['document.md', 'document.pdf']);
      rmSync(downloadDir, { recursive: true, force: true });
    });

    it('ファイル名が不正なときは、ダウンロードできない', async () => {
      await openEditor(SAMPLE);
      await page.$eval('#base-name', (element) => {
        const input = element as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, 'a/b');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const disabled = await page.evaluate(
        () => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('ダウンロードで保存'))?.disabled,
      );
      expect(disabled).toBe(true);
    });
  });

  describe('HTML・CSSの編集(実ブラウザ)', () => {
    // 整っていない書き方(省略タグ・引用符の違い・実体参照・コメント・表のtbody省略)を含む、取り込んだままの形が保たれるべきHTML
    const HTML_SAMPLE = [
      '<!DOCTYPE html>',
      '<html lang="ja">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <title>案内</title>',
      '  <style>h1 { color: #c00; } p.lead { font-weight: bold }</style>',
      '</head>',
      '<body class=main>',
      '  <h1 id=top>お知らせ &amp; ご案内</h1>',
      "  <p class='lead'>本日は休業です。&copy; 2026</p>",
      '  <!-- メモ -->',
      '  <p class="note">補足です。</p>',
      '  <ul>',
      '    <li>項目1',
      '    <li>項目2',
      '  </ul>',
      '  <table><tr><td>A</td><td>B</td></tr></table>',
      '  <pre>  整形済み\n    テキスト</pre>',
      '</body>',
      '</html>',
      '',
    ].join('\n');

    const selectPasteKind = (label: string): Promise<void> =>
      page.evaluate((text) => {
        const input = [...document.querySelectorAll('.paste-kind label')].find((l) => l.textContent?.includes(text))?.querySelector('input');
        (input as HTMLInputElement).click();
      }, label);

    // 編集できるプレビュー(iframe)が表示され、編集の準備ができるまで待つ
    const previewFrame = async (): Promise<Frame> => {
      await page.waitForFunction(
        () => (document.querySelector('iframe.html-preview-frame') as HTMLIFrameElement | null)?.contentDocument?.designMode === 'on',
      );
      const handle = await page.$('iframe.html-preview-frame');
      const frame = await handle?.contentFrame();
      if (frame === null || frame === undefined) {
        throw new Error('プレビューのiframeが見つかりません');
      }
      return frame;
    };

    async function openHtml(html: string): Promise<Frame> {
      await setPasted(html);
      await selectPasteKind('HTML');
      await clickButton('貼り付けた内容を読み込む');
      return previewFrame();
    }

    const htmlSource = async (): Promise<string> => {
      await clickButton('HTML');
      await page.waitForSelector('textarea[aria-label="HTML"]');
      return page.$eval('textarea[aria-label="HTML"]', (element) => (element as HTMLTextAreaElement).value);
    };

    // プレビュー内で、指定した要素の末尾にカーソルを置く(フォーカスはiframeへ移す)
    const caretAtEnd = async (frame: Frame, selector: string): Promise<void> => {
      await (await page.$('iframe.html-preview-frame'))?.click();
      await frame.evaluate((sel) => {
        const element = document.querySelector(sel) as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        const selection = window.getSelection() as Selection;
        selection.removeAllRanges();
        selection.addRange(range);
      }, selector);
    };

    const WAIT_FOR_DEBOUNCE_MS = 400;
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, WAIT_FOR_DEBOUNCE_MS));

    it('HTMLを貼り付けると、プレビューに表示される(CSSも適用され、エラーにならない)', async () => {
      const frame = await openHtml(HTML_SAMPLE);
      const text = await frame.$eval('body', (element) => (element as HTMLElement).innerText);
      expect(text).toContain('お知らせ & ご案内');
      expect(text).toContain('項目2');
      expect(await frame.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(204, 0, 0)');
      expect(await page.$('[role="alert"]')).toBeNull();
      await shot('10-html-preview');
      expect(consoleErrors).toEqual([]);
    });

    it('編集していなければ、実ブラウザが解釈し直した文書から差分を取っても、HTMLは1文字も変わらない', async () => {
      const frame = await openHtml(HTML_SAMPLE);
      // 編集イベントを人為的に起こし、実Chromiumが解釈した文書とソースを比較させる(差分が無ければ何も書き換わらない)
      await frame.evaluate(() => document.dispatchEvent(new Event('input')));
      await settle();
      expect(await htmlSource()).toBe(HTML_SAMPLE);
      expect(await page.$('[role="alert"]')).toBeNull();
    });

    it('プレビューで文字を編集すると、その箇所だけがHTMLへ反映され、他の部分(引用符・省略タグ・実体参照・コメント)はそのまま', async () => {
      const frame = await openHtml(HTML_SAMPLE);
      await caretAtEnd(frame, 'p.lead');
      await page.keyboard.type('ありがとう');
      await settle();

      const source = await htmlSource();
      expect(source).toBe(HTML_SAMPLE.replace('本日は休業です。&copy; 2026', '本日は休業です。© 2026ありがとう'));
      expect(source).toContain('<h1 id=top>お知らせ &amp; ご案内</h1>');
      expect(source).toContain('<li>項目1\n    <li>項目2\n  </ul>');
      expect(source).toContain('<body class=main>');
      expect(source).toContain('<!-- メモ -->');
      await shot('11-html-edited');
      expect(consoleErrors).toEqual([]);
    });

    it('「太字」ボタンで、選択した範囲がタグで囲まれ、その段落の中だけが書き換わる', async () => {
      const frame = await openHtml(HTML_SAMPLE);
      await (await page.$('iframe.html-preview-frame'))?.click();
      await frame.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('p.note') as HTMLElement);
        const selection = window.getSelection() as Selection;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await clickButton('太字');
      await settle();

      const source = await htmlSource();
      expect(source).toBe(HTML_SAMPLE.replace('<p class="note">補足です。</p>', '<p class="note"><b>補足です。</b></p>'));
    });

    it('Enterで新しい段落を作ると、その分だけが追加され、他の部分は変わらない', async () => {
      const frame = await openHtml(HTML_SAMPLE);
      await caretAtEnd(frame, 'p.lead');
      await page.keyboard.press('Enter');
      await page.keyboard.type('新しい段落');
      await settle();

      const source = await htmlSource();
      expect(source).toContain('新しい段落</p>');
      expect(source).toContain('<h1 id=top>お知らせ &amp; ご案内</h1>');
      expect(source).toContain('<li>項目1\n    <li>項目2\n  </ul>');
      expect(source).toContain('<table><tr><td>A</td><td>B</td></tr></table>');
      expect(source.startsWith('<!DOCTYPE html>\n<html lang="ja">\n<head>')).toBe(true);
      expect(source.endsWith('</body>\n</html>\n')).toBe(true);
    });

    it('HTMLタブで直接編集すると、隣のプレビューに反映され、プレビューへ戻っても編集内容が表示される', async () => {
      await openHtml(HTML_SAMPLE);
      await clickButton('HTML');
      await page.waitForSelector('textarea[aria-label="HTML"]');
      await page.$eval('textarea[aria-label="HTML"]', (element, value) => {
        const area = element as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(area, value);
        area.dispatchEvent(new Event('input', { bubbles: true }));
      }, HTML_SAMPLE.replace('項目1', '直接編集した項目'));

      const side = (await (await page.$('iframe.html-preview-frame'))?.contentFrame()) as Frame;
      await side.waitForFunction(() => document.body.innerText.includes('直接編集した項目'));
      await shot('12-html-source-tab');

      await clickButton('プレビュー');
      const frame = await previewFrame();
      await frame.waitForFunction(() => document.body.innerText.includes('直接編集した項目'));
    });

    it('スクリプトは実行されず、外部へも通信しない(プレビュー)', async () => {
      const requested: string[] = [];
      const probe: Server = createServer((req, res) => {
        requested.push(req.url ?? '');
        res.end();
      });
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const { port } = probe.address() as AddressInfo;
      try {
        const html =
          '<!DOCTYPE html><body><p id="t">前</p><script>document.getElementById("t").textContent="実行された";</script>' +
          `<img src="http://127.0.0.1:${port}/img.png" onerror="document.getElementById('t').textContent='実行された'">` +
          `<style>p { background: url(http://127.0.0.1:${port}/bg.png) }</style></body>`;
        const frame = await openHtml(html);
        await settle();

        expect(await frame.$eval('#t', (element) => element.textContent)).toBe('前');
        expect(requested).toEqual([]);
        // 出力前の警告で知らせる
        const warnings = await page.$eval('.warning-list', (element) => (element as HTMLElement).innerText);
        expect(warnings).toContain('スクリプト');
        expect(warnings).toContain('外部の画像');
      } finally {
        await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
      }
    });

    it('リンクをクリックしても、プレビューは別のページへ移らない', async () => {
      await openHtml('<!DOCTYPE html><body><p><a href="https://example.com/">リンク</a></p></body>');
      await clickButton('HTML');
      const side = (await (await page.$('iframe.html-preview-frame'))?.contentFrame()) as Frame;
      await side.waitForSelector('a');
      await side.click('a');
      await settle();
      expect(side.url()).toBe('about:srcdoc');
      expect(await side.$eval('p', (element) => element.textContent)).toBe('リンク');
    });

    describe('CSSファイルを一緒に取り込む', () => {
      let dir: string;
      const files = (): { html: string; css: string; other: string } => ({
        html: join(dir, 'index.html'),
        css: join(dir, 'style.css'),
        other: join(dir, 'other.html'),
      });
      const PAGE = '<!DOCTYPE html>\n<html>\n<head>\n<title>t</title>\n<link rel="stylesheet" href="css/style.css">\n</head>\n<body>\n<h1>見出し</h1>\n<p>本文</p>\n</body>\n</html>\n';

      beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'md-pdf-editor-html-'));
        writeFileSync(files().html, PAGE);
        writeFileSync(files().css, 'h1 { color: rgb(204, 0, 0); }');
        writeFileSync(files().other, '<p>別</p>');
      });

      const upload = async (...paths: string[]): Promise<void> => {
        await page.goto(baseUrl);
        await page.waitForSelector('input[type=file]', { hidden: true });
        const input = (await page.$('input[type=file]')) as ElementHandle<HTMLInputElement>;
        await input.uploadFile(...paths);
      };

      it('HTMLの<link>と同じ名前のCSSが適用され、CSSタブで編集でき、隣のプレビューに反映される', async () => {
        await upload(files().css, files().html);
        const frame = await previewFrame();
        expect(await frame.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(204, 0, 0)');
        // 参照されているCSSなので、「参照されていない」旨の警告は出ない
        expect(await page.$('.warning-list')).toBeNull();
        expect(await page.$$eval('.tab', (tabs) => tabs.map((tab) => tab.textContent))).toEqual(['プレビュー(直接編集)', 'HTML', 'CSS: style.css']);

        await clickButton('CSS: style.css');
        await page.waitForSelector('textarea[aria-label="CSS: style.css"]');
        await page.$eval('textarea[aria-label="CSS: style.css"]', (element) => {
          const area = element as HTMLTextAreaElement;
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(area, 'h1 { color: rgb(0, 0, 255); }');
          area.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const side = (await (await page.$('iframe.html-preview-frame'))?.contentFrame()) as Frame;
        await side.waitForFunction(() => getComputedStyle(document.querySelector('h1') as Element).color === 'rgb(0, 0, 255)');
        await shot('13-css-tab');

        // プレビューへ戻っても、編集したCSSが適用されている。HTMLは、CSSを埋め込まれず、取り込んだままである
        await clickButton('プレビュー');
        const edited = await previewFrame();
        expect(await edited.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(0, 0, 255)');
        expect(await htmlSource()).toBe(PAGE);
      });

      it('HTML・CSS・PDFを、HTMLの参照名(style.css)のまま、選んだフォルダへ出力できる', async () => {
        await upload(files().html, files().css);
        const frame = await previewFrame();
        await caretAtEnd(frame, 'p');
        await page.keyboard.type('(追記)');
        await settle();

        // HTMLが css/style.css を指しているため、CSSも、HTMLと同じ出力フォルダの css/style.css に保存する
        const labels = await page.$$eval('.file-select label', (items) => items.map((item) => item.textContent?.trim()));
        expect(labels).toEqual(['HTML (.html)', 'CSS (css/style.css)', 'PDF (.pdf)']);
        await clickButton('出力先フォルダを選択');
        await page.waitForFunction(
          () => !([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('選んだフォルダへHTMLとCSSとPDFを出力'))?.disabled ?? true),
        );
        await clickButton('選んだフォルダへHTMLとCSSとPDFを出力');
        await page.waitForSelector('.notice-success', { timeout: 60_000 });

        const saved = await page.evaluate(async () => {
          const dir = await navigator.storage.getDirectory();
          const names: string[] = [];
          for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
            names.push(name);
          }
          const read = async (name: string) => (await (await dir.getFileHandle(name)).getFile()).text();
          return {
            names: names.sort(),
            html: await read('index.html'),
            css: await (await (await dir.getDirectoryHandle('css')).getFileHandle('style.css')).getFile().then((f) => f.text()),
            pdfHeader: (await read('index.pdf')).slice(0, 5),
          };
        });
        expect(saved.names).toEqual(['css', 'index.html', 'index.pdf']);
        expect(saved.html).toBe(PAGE.replace('<p>本文</p>', '<p>本文(追記)</p>'));
        expect(saved.css).toBe('h1 { color: rgb(204, 0, 0); }');
        expect(saved.pdfHeader).toBe('%PDF-');
        await shot('14-html-output');
        expect(consoleErrors).toEqual([]);
      });

      it('HTMLだけを選んで保存すると、ファイル名の指定は.htmlに使われ、CSSとPDFは保存されない', async () => {
        await upload(files().html, files().css);
        await previewFrame();
        await page.evaluate(() => {
          for (const text of ['CSS (css/style.css)', 'PDF (.pdf)']) {
            const input = [...document.querySelectorAll('.file-select label')].find((l) => l.textContent?.includes(text))?.querySelector('input');
            (input as HTMLInputElement).click();
          }
        });
        await page.$eval('#base-name', (element) => {
          const input = element as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          setter?.call(input, '案内');
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await clickButton('出力先フォルダを選択');
        await page.waitForFunction(
          () => !([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('選んだフォルダへHTMLを出力'))?.disabled ?? true),
        );
        await clickButton('選んだフォルダへHTMLを出力');
        await page.waitForSelector('.notice-success');
        const names = await page.evaluate(async () => {
          const dir = await navigator.storage.getDirectory();
          const found: string[] = [];
          for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
            found.push(name);
          }
          return found;
        });
        expect(names).toEqual(['案内.html']);
      });

      it('CSSだけ・HTMLが2つ・Markdownと一緒のCSSは、取り込まず理由を表示する', async () => {
        await upload(files().css);
        await page.waitForSelector('[role="alert"]');
        expect(await page.$eval('[role="alert"]', (element) => (element as HTMLElement).innerText)).toContain('CSSファイルだけは取り込めません');

        await upload(files().html, files().other);
        await page.waitForSelector('[role="alert"]');
        expect(await page.$eval('[role="alert"]', (element) => (element as HTMLElement).innerText)).toContain('1つずつ取り込んでください');
      });

      it('どの<link>にも参照されていないCSSは、<head>の末尾に追加して適用し、その旨を知らせる', async () => {
        writeFileSync(files().html, '<!DOCTYPE html>\n<html>\n<head>\n<title>t</title>\n</head>\n<body>\n<h1>見出し</h1>\n</body>\n</html>\n');
        await upload(files().html, files().css);
        const frame = await previewFrame();
        expect(await frame.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(204, 0, 0)');
        const warnings = await page.$eval('.warning-list', (element) => (element as HTMLElement).innerText);
        expect(warnings).toContain('style.css');
        expect(warnings).toContain('追加して適用');
      });
    });
  describe('フォルダごとの取り込みと画像(実ブラウザ)', () => {
    // 1x1のPNG
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    interface Entry {
      path: string;
      text?: string;
      base64?: string;
    }

    // フォルダの選択ダイアログは操作できないため、「選んだフォルダ内のファイル(相対パスつき)」を、フォルダ選択の入力へ渡す
    async function importFolder(entries: Entry[], root = 'site'): Promise<void> {
      await page.goto(baseUrl);
      await page.waitForSelector('input[aria-label="フォルダを選択"]', { hidden: true });
      await page.evaluate(
        (items, rootName) => {
          const input = document.querySelector('input[aria-label="フォルダを選択"]') as HTMLInputElement;
          const files = items.map((item) => {
            const bytes = item.base64 !== undefined ? Uint8Array.from(atob(item.base64), (c) => c.charCodeAt(0)) : new TextEncoder().encode(item.text ?? '');
            const file = new File([bytes], item.path.split('/').pop() as string);
            Object.defineProperty(file, 'webkitRelativePath', { value: `${rootName}/${item.path}` });
            return file;
          });
          Object.defineProperty(input, 'files', { value: files, configurable: true });
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
        entries,
        root,
      );
    }

    const SETTLE_MS = 400;
    const settleAfterEdit = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    const waitForPreviewFrame = async (): Promise<Frame> => {
      await page.waitForFunction(
        () => (document.querySelector('iframe.html-preview-frame') as HTMLIFrameElement | null)?.contentDocument?.designMode === 'on',
        { timeout: 30_000 },
      );
      return (await (await page.$('iframe.html-preview-frame'))?.contentFrame()) as Frame;
    };

    const imageLoadedIn = (frame: Frame): Promise<unknown> =>
      frame.waitForFunction(() => {
        const image = document.querySelector('img');
        return image !== null && image.complete && image.naturalWidth > 0;
      });

    const pdfImageCount = (bytes: number[]): number => {
      const path = join(mkdtempSync(join(tmpdir(), 'md-pdf-editor-pdfimg-')), 'out.pdf');
      writeFileSync(path, Buffer.from(bytes));
      return execFileSync('pdfimages', ['-list', path], { encoding: 'utf8' })
        .split('\n')
        .filter((line) => /^\s*\d+\s+\d+\s+image\b/.test(line)).length;
    };

    const outputTo = async (label: string): Promise<void> => {
      await clickButton('出力先フォルダを選択');
      await page.waitForFunction(
        (text) => !([...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))?.disabled ?? true),
        {},
        label,
      );
      await clickButton(label);
      await page.waitForSelector('.notice-success', { timeout: 60_000 });
    };

    const readOpfs = (path: string): Promise<number[] | null> =>
      page.evaluate(async (target) => {
        let dir = await navigator.storage.getDirectory();
        const segments = target.split('/');
        try {
          for (const segment of segments.slice(0, -1)) {
            dir = await dir.getDirectoryHandle(segment);
          }
          const file = await (await dir.getFileHandle(segments[segments.length - 1] as string)).getFile();
          return [...new Uint8Array(await file.arrayBuffer())];
        } catch {
          return null;
        }
      }, path);

    const listOpfsRoot = (): Promise<string[]> =>
      page.evaluate(async () => {
        const dir = await navigator.storage.getDirectory();
        const names: string[] = [];
        for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
          names.push(name);
        }
        return names.sort();
      });

    const INDEX_HTML =
      '<!DOCTYPE html>\n<html>\n<head>\n<link rel="stylesheet" href="css/style.css">\n</head>\n<body>\n<h1>見出し</h1>\n<p>本文</p>\n<img src="images/a.png" alt="図">\n</body>\n</html>\n';
    const SITE: Entry[] = [
      { path: 'index.html', text: INDEX_HTML },
      { path: 'css/style.css', text: 'h1 { color: rgb(204, 0, 0); }\nbody { background: url(../images/bg.png) }' },
      { path: 'css/unused.css', text: 'p { color: blue }' },
      { path: 'images/a.png', base64: PNG },
      { path: 'images/bg.png', base64: PNG },
    ];

    it('HTMLを含むフォルダを取り込むと、参照しているCSS・画像が、フォルダ内の位置のとおりに読み込まれて表示される', async () => {
      await importFolder(SITE);
      const frame = await waitForPreviewFrame();
      await imageLoadedIn(frame);

      expect(await frame.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(204, 0, 0)');
      // CSS内の url(../images/bg.png) は、CSSのフォルダを基準に解決される
      expect(await frame.$eval('body', (element) => getComputedStyle(element).backgroundImage)).toContain('blob:');
      // HTMLが参照しているCSSだけを取り込む(フォルダ内の他のCSSは取り込まない)
      expect(await page.$$eval('.tab', (tabs) => tabs.map((tab) => tab.textContent))).toEqual(['プレビュー(直接編集)', 'HTML', 'CSS: css/style.css']);
      expect(await page.$('.warning-list')).toBeNull();
      expect(consoleErrors).toEqual([]);
      await shot('15-folder-html');
    });

    it('編集していなければ、画像を埋め込んだプレビューから差分を取っても、HTMLの画像の参照は変わらない', async () => {
      await importFolder(SITE);
      const frame = await waitForPreviewFrame();
      await imageLoadedIn(frame);
      await frame.evaluate(() => document.dispatchEvent(new Event('input')));
      await settleAfterEdit();

      await clickButton('HTML');
      await page.waitForSelector('textarea[aria-label="HTML"]');
      expect(await page.$eval('textarea[aria-label="HTML"]', (element) => (element as HTMLTextAreaElement).value)).toBe(INDEX_HTML);
    });

    it('プレビューで文字を編集しても、画像の参照(images/a.png)は、data: URIに書き換わらない', async () => {
      await importFolder(SITE);
      const frame = await waitForPreviewFrame();
      await imageLoadedIn(frame);
      await (await page.$('iframe.html-preview-frame'))?.click();
      await frame.evaluate(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('p') as HTMLElement);
        range.collapse(false);
        const selection = window.getSelection() as Selection;
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await page.keyboard.type('(追記)');
      await settleAfterEdit();

      await clickButton('HTML');
      await page.waitForSelector('textarea[aria-label="HTML"]');
      const source = await page.$eval('textarea[aria-label="HTML"]', (element) => (element as HTMLTextAreaElement).value);
      expect(source).toBe(INDEX_HTML.replace('<p>本文</p>', '<p>本文(追記)</p>'));
      expect(source).not.toContain('data:');
      expect(source).not.toContain('blob:');
    });

    it('HTML・CSS・PDFを出力すると、CSSは<link>が指している位置(css/style.css)に保存され、PDFには画像が入り、HTML・CSSは取り込んだまま', async () => {
      await importFolder(SITE);
      const frame = await waitForPreviewFrame();
      await imageLoadedIn(frame);
      await outputTo('選んだフォルダへHTMLとCSSとPDFを出力');

      expect(await listOpfsRoot()).toEqual(['css', 'index.html', 'index.pdf']);
      expect(Buffer.from((await readOpfs('index.html')) ?? []).toString('utf8')).toBe(INDEX_HTML);
      expect(Buffer.from((await readOpfs('css/style.css')) ?? []).toString('utf8')).toBe(SITE[1]?.text);
      expect(pdfImageCount((await readOpfs('index.pdf')) ?? [])).toBeGreaterThan(0);
      await shot('16-folder-html-output');
    });

    it('フォルダを実際にドラッグ&ドロップすると、下位のフォルダのCSS・画像まで読み込まれる(隠しフォルダ・node_modulesは読まない)', async () => {
      const site = mkdtempSync(join(tmpdir(), 'md-pdf-editor-drop-'));
      for (const directory of ['css', 'images', '.git', 'node_modules']) {
        mkdirSync(join(site, directory));
      }
      writeFileSync(join(site, 'index.html'), INDEX_HTML);
      writeFileSync(join(site, 'css/style.css'), 'h1 { color: rgb(204, 0, 0); }');
      writeFileSync(join(site, 'images/a.png'), Buffer.from(PNG, 'base64'));
      // 隠しフォルダ・node_modulesの中のHTMLは、候補に入らない(入れば、開くファイルの選択になる)
      writeFileSync(join(site, '.git/other.html'), '<p>x</p>');
      writeFileSync(join(site, 'node_modules/lib.html'), '<p>x</p>');

      await page.goto(baseUrl);
      await page.waitForSelector('.drop-zone');
      const box = await (await page.$('.drop-zone'))?.boundingBox();
      const client = await page.createCDPSession();
      const data = { items: [], files: [site], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await client.send('Input.dispatchDragEvent', { type, x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2, data });
      }
      const frame = await waitForPreviewFrame();
      await imageLoadedIn(frame);
      expect(await frame.$eval('h1', (element) => getComputedStyle(element).color)).toBe('rgb(204, 0, 0)');
      expect(await page.$$eval('.tab', (tabs) => tabs.map((tab) => tab.textContent))).toEqual(['プレビュー(直接編集)', 'HTML', 'CSS: css/style.css']);
      rmSync(site, { recursive: true, force: true });
    });

    it('見つからない画像と外部の画像は、区別して警告する', async () => {
      await importFolder([{ path: 'a.html', text: '<p>x</p><img src="images/none.png"><img src="https://example.com/a.png">' }]);
      await waitForPreviewFrame();
      const warnings = await page.$eval('.warning-list', (element) => (element as HTMLElement).innerText);
      expect(warnings).toContain('見つからない画像');
      expect(warnings).toContain('外部の画像');
    });

    it('ファイルを個別に選んだ場合は、HTMLの<img src="images/a.png">が、選んだ画像(a.png)にファイル名で対応する', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'md-pdf-editor-flat-'));
      writeFileSync(join(dir, 'index.html'), '<!DOCTYPE html>\n<body>\n<img src="images/a.png">\n</body>\n');
      writeFileSync(join(dir, 'a.png'), Buffer.from(PNG, 'base64'));
      await page.goto(baseUrl);
      await page.waitForSelector('input[type=file]', { hidden: true });
      await ((await page.$('input[type=file]')) as ElementHandle<HTMLInputElement>).uploadFile(join(dir, 'index.html'), join(dir, 'a.png'));
      const frame = await waitForPreviewFrame();
      await imageLoadedIn(frame);
      expect(await page.$('.warning-list')).toBeNull();
      rmSync(dir, { recursive: true, force: true });
    });

    it('フォルダにMarkdownまたはHTMLが複数あるときは、開くファイルを選べる', async () => {
      await importFolder([
        { path: 'a.html', text: '<p>HTMLの文書</p>' },
        { path: 'docs/b.md', text: '# Markdownの文書' },
      ]);
      await page.waitForSelector('.choose-list');
      expect(await page.$$eval('.choose-list button', (buttons) => buttons.map((button) => button.textContent))).toEqual(['a.html', 'docs/b.md']);
      await clickButton('docs/b.md');
      await page.waitForSelector('.md-editor-content h1');
      expect(await page.$$eval('.tab', (tabs) => tabs.map((tab) => tab.textContent))).toEqual(['プレビュー(書式付きで編集)', 'Markdown']);
    });

    it('MarkdownやHTMLが無いフォルダは、取り込まず理由を表示する', async () => {
      await importFolder([{ path: 'images/a.png', base64: PNG }]);
      await page.waitForSelector('[role="alert"]');
      expect(await page.$eval('[role="alert"]', (element) => (element as HTMLElement).innerText)).toContain('見つかりません');
    });

    it('Markdownの画像(![図](img/a.png))を、フォルダ内の位置のとおりに、エディタに表示し、PDFにも入れる(Markdownの本文は変わらない)', async () => {
      const markdown = '# 題\n\n![図](img/a.png)\n';
      await importFolder([
        { path: 'docs/guide.md', text: markdown },
        { path: 'docs/img/a.png', base64: PNG },
      ]);
      await page.waitForSelector('.md-editor-content h1');
      await page.waitForFunction(() => {
        const image = document.querySelector('.md-editor-content img') as HTMLImageElement | null;
        return image !== null && image.complete && image.naturalWidth > 0;
      });
      expect(await page.$('.warning-list')).toBeNull();

      await page.click('.md-editor-content h1');
      await page.keyboard.press('End');
      await page.keyboard.type('改');
      await clickButton('Markdown');
      const edited = await sourceValue();
      expect(edited).toContain('# 題改');
      expect(edited).toContain('![図](img/a.png)');
      expect(edited).not.toContain('data:');
      expect(edited).not.toContain('blob:');

      await outputTo('選んだフォルダへMDとPDFを出力');
      expect(await listOpfsRoot()).toEqual(['guide.md', 'guide.pdf']);
      expect(Buffer.from((await readOpfs('guide.md')) ?? []).toString('utf8')).toContain('![図](img/a.png)');
      expect(pdfImageCount((await readOpfs('guide.pdf')) ?? [])).toBeGreaterThan(0);
      await shot('17-folder-markdown');
    });

    it('Markdownの画像が見つからない場合は、警告する', async () => {
      await importFolder([{ path: 'a.md', text: '![図](images/none.png)' }]);
      await page.waitForSelector('.warning-list');
      expect(await page.$eval('.warning-list', (element) => (element as HTMLElement).innerText)).toContain('表示できない画像');
    });
  });
  });

  it('「PDFを生成して確認」でPDFが新しいタブに開く', async () => {
    await openEditor(SAMPLE);
    const popupPromise = new Promise<Page>((resolve) => {
      browser.once('targetcreated', (target) => void target.page().then((created) => resolve(created as Page)));
    });
    await clickButton('PDFを生成して確認');
    const popup = await popupPromise;
    await popup.waitForFunction(() => location.href.startsWith('blob:'), { timeout: 60_000 });
    expect(popup.url()).toMatch(/^blob:http:\/\/127\.0\.0\.1:\d+\//);
    await popup.close();
  });
});
