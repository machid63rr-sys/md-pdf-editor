import puppeteer, { type Browser } from 'puppeteer-core';
import { SerialQueue } from './serialQueue.js';

export class PdfRenderError extends Error {}

export interface RenderOptions {
  // 文書のCSS(@page { size: … })が指定する用紙サイズを、既定のA4より優先する(利用者のHTML用)
  readonly preferCssPageSize?: boolean;
}

export interface PdfRenderer {
  render(html: string, options?: RenderOptions): Promise<Buffer>;
  chromiumVersion(): Promise<string>;
}

export interface PdfRendererOptions {
  readonly chromiumPath: string;
  readonly timeoutMs: number;
}

// コンテナ内では非rootでサンドボックスを使えないため --no-sandbox で起動する。
// その代わり、描画するHTMLは「JS無効・外部通信遮断・生HTML非実行」に限定している
const LAUNCH_ARGS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none'];

// フッターにはページ本文のCSSが効かないため、フォント指定はインラインで行う
const FOOTER_TEMPLATE =
  '<div style="font-size:9px;font-family:\'Noto Sans CJK JP\',sans-serif;width:100%;text-align:center;color:#555;">' +
  '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

async function closeBrowser(browser: Browser): Promise<void> {
  try {
    await browser.close();
  } catch (cause) {
    console.error(`Chromiumの終了に失敗したため強制終了します: ${messageOf(cause)}`);
    browser.process()?.kill('SIGKILL');
  }
}

export function createPdfRenderer(options: PdfRendererOptions): PdfRenderer {
  const queue = new SerialQueue();

  // 常駐させず、要求ごとに起動・終了する(クラッシュや切断の後始末を持たないため)
  const launch = (): Promise<Browser> =>
    puppeteer.launch({
      executablePath: options.chromiumPath,
      headless: true,
      args: LAUNCH_ARGS,
      timeout: options.timeoutMs,
    });

  return {
    render(html: string, renderOptions?: RenderOptions): Promise<Buffer> {
      return queue.run(async () => {
        let browser: Browser | undefined;
        try {
          browser = await launch();
          const page = await browser.newPage();
          page.setDefaultTimeout(options.timeoutMs);
          await page.setJavaScriptEnabled(false);
          await page.setRequestInterception(true);
          page.on('request', (request) => {
            const url = request.url();
            if (url.startsWith('data:') || url === 'about:blank') {
              void request.continue();
            } else {
              void request.abort('blockedbyclient');
            }
          });
          await page.setContent(html, { waitUntil: 'load', timeout: options.timeoutMs });
          const pdf = await page.pdf({
            format: 'A4',
            margin: { top: '20mm', bottom: '25mm', left: '20mm', right: '20mm' },
            printBackground: true,
            preferCSSPageSize: renderOptions?.preferCssPageSize ?? false,
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: FOOTER_TEMPLATE,
            timeout: options.timeoutMs,
          });
          return Buffer.from(pdf);
        } catch (cause) {
          throw new PdfRenderError(`PDFの生成に失敗しました: ${messageOf(cause)}`, { cause });
        } finally {
          if (browser !== undefined) {
            await closeBrowser(browser);
          }
        }
      });
    },

    chromiumVersion(): Promise<string> {
      return queue.run(async () => {
        let browser: Browser | undefined;
        try {
          browser = await launch();
          return await browser.version();
        } catch (cause) {
          throw new PdfRenderError(`Chromiumを起動できません: ${messageOf(cause)}`, { cause });
        } finally {
          if (browser !== undefined) {
            await closeBrowser(browser);
          }
        }
      });
    },
  };
}
