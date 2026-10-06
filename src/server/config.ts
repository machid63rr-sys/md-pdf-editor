export interface Config {
  readonly port: number;
  readonly host: string;
  // POST /api/pdf で受け付けるMarkdownの最大バイト数(UTF-8換算)
  readonly maxMarkdownBytes: number;
  // Chromiumの起動・描画・PDF化それぞれに適用するタイムアウト
  readonly pdfTimeoutMs: number;
  readonly chromiumPath: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '0.0.0.0';
// 文書に含まれる画像(data: URIにするため、元のファイルの約1.3倍になる)を含めた大きさ
const DEFAULT_MAX_MARKDOWN_BYTES = 30 * 1024 * 1024;
const DEFAULT_PDF_TIMEOUT_MS = 60_000;
const DEFAULT_CHROMIUM_PATH = '/usr/bin/chromium';

// 未指定ならdefault。指定されているのに不正な値は、黙ってdefaultへ戻さずエラーにする
function readPositiveInteger(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
    throw new Error(`環境変数 ${name} は正の整数で指定してください (指定値: "${raw}")`);
  }
  return Number(raw);
}

export function loadConfig(env: Env = process.env): Config {
  const port = readPositiveInteger(env, 'PORT', DEFAULT_PORT);
  if (port > 65535) {
    throw new Error(`環境変数 PORT は 1〜65535 で指定してください (指定値: "${port}")`);
  }
  return {
    port,
    host: env['HOST'] || DEFAULT_HOST,
    maxMarkdownBytes: readPositiveInteger(env, 'MAX_MARKDOWN_BYTES', DEFAULT_MAX_MARKDOWN_BYTES),
    pdfTimeoutMs: readPositiveInteger(env, 'PDF_TIMEOUT_MS', DEFAULT_PDF_TIMEOUT_MS),
    chromiumPath: env['CHROMIUM_PATH'] || DEFAULT_CHROMIUM_PATH,
  };
}
