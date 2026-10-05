import express, { type ErrorRequestHandler, type Express, type NextFunction, type Request, type Response } from 'express';
import { buildDocumentHtml } from './markdownToHtml.js';
import { PdfRenderError, type PdfRenderer } from './pdf.js';

export interface AppDependencies {
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

function parseMarkdown(body: unknown, maxBytes: number): string {
  const markdown = (body as { markdown?: unknown } | undefined)?.markdown;
  if (typeof markdown !== 'string') {
    throw new ApiError(400, 'invalid_request', 'リクエストは {"markdown": "<文字列>"} の形式で指定してください。');
  }
  if (markdown.trim() === '') {
    throw new ApiError(400, 'empty_markdown', 'Markdownが空です。');
  }
  if (Buffer.byteLength(markdown, 'utf8') > maxBytes) {
    throw new ApiError(413, 'markdown_too_large', `Markdownが大きすぎます(上限 ${maxBytes} バイト)。`);
  }
  return markdown;
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
    const markdown = parseMarkdown(req.body, deps.maxMarkdownBytes);
    const pdf = await deps.renderer.render(buildDocumentHtml(markdown, deps.css));
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
      sendError(res, 413, 'markdown_too_large', `リクエストが大きすぎます(Markdownの上限 ${deps.maxMarkdownBytes} バイト)。`);
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
