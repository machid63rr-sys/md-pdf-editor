import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
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
  // 「名前を付けて保存」ダイアログの代わりに、OPFSに提案名のファイルを新規作成して返す。
  // window.__cancelSave を true にすると、利用者がダイアログを閉じた場合(AbortError)を再現する
  await page.evaluateOnNewDocument(() => {
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (options: { suggestedName: string }) => {
      if ((window as unknown as { __cancelSave?: boolean }).__cancelSave === true) {
        throw new DOMException('The user aborted a request.', 'AbortError');
      }
      const dir = await navigator.storage.getDirectory();
      try {
        await dir.removeEntry(options.suggestedName);
      } catch {
        // まだ存在しない場合は何もしない
      }
      return dir.getFileHandle(options.suggestedName, { create: true });
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
    expect(warnings).toContain('data URI以外の画像');
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
      name: { disabled: boolean };
      folder: boolean;
      primary: string;
      primaryDisabled: boolean;
      download: boolean;
      hint: string;
    }> =>
      page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')];
        const find = (text: string) => buttons.find((b) => b.textContent?.includes(text));
        const primary = document.querySelector('.actions .button-primary') as HTMLButtonElement;
        return {
          name: { disabled: (document.getElementById('base-name') as HTMLInputElement).disabled },
          folder: find('出力先フォルダを選択')?.disabled ?? true,
          primary: primary.textContent ?? '',
          primaryDisabled: primary.disabled,
          download: find('ダウンロードで保存')?.disabled ?? true,
          hint: (document.querySelector('.output-panel') as HTMLElement).innerText,
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

    it('初期状態は両方チェック。ファイル名を編集でき、フォルダを選んでまとめて出力する', async () => {
      await openEditor(SAMPLE);
      const initial = await state();
      expect(initial.name.disabled).toBe(false);
      expect(initial.folder).toBe(false);
      expect(initial.primary).toBe('選んだフォルダへMDとPDFを出力');
      expect(initial.download).toBe(false);
      await shot('7-select-both');
    });

    it.each([
      ['Markdown (.md)', 'PDF (.pdf)', '名前を付けてPDFを保存…'],
      ['PDF (.pdf)', 'Markdown (.md)', '名前を付けてMDを保存…'],
    ])('%s を外すと(%sだけ保存)、ファイル名欄・フォルダ選択・ダウンロードがグレーになり、名前を付けて保存に切り替わる', async (unchecked, _kept, expectedLabel) => {
      await openEditor(SAMPLE);
      await setChecked(unchecked, false);

      const single = await state();
      expect(single.name.disabled).toBe(true);
      expect(single.folder).toBe(true);
      expect(single.download).toBe(true);
      expect(single.primary).toBe(expectedLabel);
      expect(single.primaryDisabled).toBe(false);
      expect(single.hint).toContain('名前を付けて保存」のダイアログで指定します');
      await shot('8-select-single');

      // 両方に戻すと、元の状態に戻る
      await setChecked(unchecked, true);
      const both = await state();
      expect(both.name.disabled).toBe(false);
      expect(both.folder).toBe(false);
      expect(both.primary).toBe('選んだフォルダへMDとPDFを出力');
    });

    it('両方外すと、保存系のボタンはすべて無効になり、選ぶよう促す', async () => {
      await openEditor(SAMPLE);
      await setChecked('Markdown (.md)', false);
      await setChecked('PDF (.pdf)', false);

      const none = await state();
      expect(none.name.disabled).toBe(true);
      expect(none.folder).toBe(true);
      expect(none.primaryDisabled).toBe(true);
      expect(none.download).toBe(true);
      expect(none.hint).toContain('保存するファイルを1つ以上選んでください');
    });

    it('PDFだけ保存: ダイアログの提案名は「<名前>.pdf」。ダイアログで保存先が決まった後にPDFが書き込まれる', async () => {
      await openEditor(SAMPLE);
      await setChecked('Markdown (.md)', false);
      await clickButton('名前を付けてPDFを保存');
      await page.waitForSelector('.notice-success', { timeout: 60_000 });

      const status = await page.$eval('.notice-success', (element) => (element as HTMLElement).innerText);
      expect(status).toContain('document.pdf');
      const pdf = await savedFile('document.pdf');
      expect(pdf?.header).toBe('%PDF-');
      expect(await savedFile('document.md')).toBeNull();
      await shot('9-save-pdf-only');
      expect(consoleErrors).toEqual([]);
    });

    it('Markdownだけ保存: 編集した内容がそのまま書き込まれる', async () => {
      await openEditor(SAMPLE);
      await setChecked('PDF (.pdf)', false);
      await clickButton('名前を付けてMDを保存');
      await page.waitForSelector('.notice-success');

      expect((await savedFile('document.md'))?.text).toBe(SAMPLE);
      expect(await savedFile('document.pdf')).toBeNull();
    });

    it('ダイアログを閉じた(中止した)場合は、何も保存せず、エラーも出さない', async () => {
      await openEditor(SAMPLE);
      await setChecked('Markdown (.md)', false);
      await page.evaluate(() => {
        (window as unknown as { __cancelSave: boolean }).__cancelSave = true;
      });
      await clickButton('名前を付けてPDFを保存');
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(await page.$('[role="alert"]')).toBeNull();
      expect(await page.$('.notice-success')).toBeNull();
      expect(await savedFile('document.pdf')).toBeNull();
      // 中止の後も、続けて操作できる
      const after = await state();
      expect(after.primaryDisabled).toBe(false);
    });

    it('「名前を付けて保存」に対応していないブラウザで1つだけ保存する場合は、ファイル名を編集でき、ダウンロードで保存する', async () => {
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
      });
      const downloads = mkdtempSync(join(tmpdir(), 'md-pdf-editor-single-'));
      const client = await page.createCDPSession();
      await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
      await openEditor(SAMPLE);
      await setChecked('PDF (.pdf)', false);

      const single = await state();
      expect(single.name.disabled).toBe(false);
      expect(single.download).toBe(false);
      expect(single.primaryDisabled).toBe(true);

      await clickButton('ダウンロードで保存');
      await page.waitForSelector('.notice-success');
      const deadline = Date.now() + 30_000;
      while (!readdirSync(downloads).includes('document.md') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(readdirSync(downloads).sort()).toEqual(['document.md']);
      expect(readFileSync(join(downloads, 'document.md'), 'utf8')).toBe(SAMPLE);
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
