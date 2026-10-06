import express, { type ErrorRequestHandler, type Express, type NextFunction, type Request, type Response } from 'express';
import { prepareHtmlForPdf } from './htmlDocument.js';
import { buildDocumentHtml, type MarkdownAssets } from './markdownToHtml.js';
import { PdfRenderError, type PdfRenderer } from './pdf.js';

export interface AppDependencies {
  // MarkdownまたはHTMLの最大バイト数(UTF-8換算)
  readonly maxMarkdownBytes: number;
  readonly renderer: PdfRenderer;
  // PDFに適用する共有CSS(プレビューと同じもの)
  readonly css: string;
  // ビルド済みクライアント(dist/client)のディレクトリ
  readonly clientDir: string;
  // /healthz に表示するChromiumの版
  readonly chromiumVersion: string;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const sendError = (res: Response, status: number, code: string, message: string): void => {
  res.status(status).json({ error: { code, message } });
};

// 画像の参照先が外部でもプレビューに出ないよう、読み込み元を自分自身とdata/blobに限る
const CONTENT_SECURITY_POLICY = "img-src 'self' data: blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  next();
}

interface PdfSource {
  readonly kind: 'markdown' | 'html';
  readonly text: string;
  // Markdownの相対パスの画像(kindがmarkdownのときだけ)
  readonly assets?: MarkdownAssets;
}

const SOURCE_LABEL = { markdown: 'Markdown', html: 'HTML' } as const;

// 画像の数・パスの長さの上限(巨大なリクエストで、処理が重くならないように)
const MAX_ASSET_FILES = 1000;
const MAX_PATH_LENGTH = 1000;

const invalid = (message: string): ApiError => new ApiError(400, 'invalid_request', message);

function parseAssets(baseDir: unknown, assets: unknown): MarkdownAssets | undefined {
  if (baseDir === undefined && assets === undefined) {
    return undefined;
  }
  if (typeof baseDir !== 'string' || baseDir.length > MAX_PATH_LENGTH) {
    throw invalid('baseDir は、文字列で指定してください。');
  }
  if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) {
    throw invalid('assets は、{"パス": "data:image/…;base64,…"} の形式で指定してください。');
  }
  const entries = Object.entries(assets);
  if (entries.length > MAX_ASSET_FILES || entries.some(([path, uri]) => path.length > MAX_PATH_LENGTH || typeof uri !== 'string')) {
    throw invalid(`assets は、パス(${MAX_PATH_LENGTH}文字以内)と文字列の組を、${MAX_ASSET_FILES}個以内で指定してください。`);
  }
  return { baseDir, files: Object.fromEntries(entries) as Record<string, string> };
}

// リクエストは {"markdown": "…"} か {"html": "…"} のどちらか一方。markdownには、画像(baseDir・assets)を添えられる
function parseSource(body: unknown, maxBytes: number): PdfSource {
  const { markdown, html, baseDir, assets } = (body ?? {}) as { markdown?: unknown; html?: unknown; baseDir?: unknown; assets?: unknown };
  if (markdown !== undefined && html !== undefined) {
    throw invalid('markdown と html は同時に指定できません。どちらか一方を指定してください。');
  }
  const kind = html !== undefined ? 'html' : 'markdown';
  const text = html !== undefined ? html : markdown;
  if (typeof text !== 'string') {
    throw invalid('リクエストは {"markdown": "<文字列>"} または {"html": "<文字列>"} の形式で指定してください。');
  }
  if (kind === 'html' && (baseDir !== undefined || assets !== undefined)) {
    throw invalid('baseDir・assets は、markdown のときだけ指定できます(HTMLは、画像を data: URI にして含めてください)。');
  }
  if (text.trim() === '') {
    throw new ApiError(400, `empty_${kind}`, `${SOURCE_LABEL[kind]}が空です。`);
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new ApiError(413, `${kind}_too_large`, `${SOURCE_LABEL[kind]}が大きすぎます(上限 ${maxBytes} バイト)。`);
  }
  const parsedAssets = kind === 'markdown' ? parseAssets(baseDir, assets) : undefined;
  return parsedAssets === undefined ? { kind, text } : { kind, text, assets: parsedAssets };
}

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', chromium: deps.chromiumVersion });
  });

  // JSON表現はエスケープで本文より大きくなりうるため、本文の上限の2倍までパースを許可し、
  // 厳密な上限はバイト数で判定する
  const jsonParser = express.json({ limit: deps.maxMarkdownBytes * 2 + 1024 });

  app.post('/api/pdf', jsonParser, async (req, res) => {
    const source = parseSource(req.body, deps.maxMarkdownBytes);
    const pdf =
      source.kind === 'markdown'
        ? await deps.renderer.render(buildDocumentHtml(source.text, deps.css, source.assets))
        : await deps.renderer.render(prepareHtmlForPdf(source.text), { preferCssPageSize: true });
    res.status(200).type('application/pdf').setHeader('Cache-Control', 'no-store');
    res.send(pdf);
  });

  app.use('/api', (_req, res) => {
    sendError(res, 404, 'not_found', '指定されたAPIは存在しません。');
  });

  app.use(
    express.static(deps.clientDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  const errorHandler: ErrorRequestHandler = (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof ApiError) {
      sendError(res, err.status, err.code, err.message);
      return;
    }
    const type = (err as { type?: unknown } | null)?.type;
    if (type === 'entity.too.large') {
      sendError(res, 413, 'markdown_too_large', `リクエストが大きすぎます(Markdown・HTMLの上限 ${deps.maxMarkdownBytes} バイト)。`);
      return;
    }
    if (type === 'entity.parse.failed') {
      sendError(res, 400, 'invalid_json', 'リクエストのJSONを解釈できません。');
      return;
    }
    if (err instanceof PdfRenderError) {
      console.error(err);
      sendError(res, 500, 'pdf_failed', err.message);
      return;
    }
    console.error(err);
    sendError(res, 500, 'internal_error', 'サーバ内部でエラーが発生しました。');
  };
  app.use(errorHandler);

  return app;
}
