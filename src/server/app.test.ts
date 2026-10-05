import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { PdfRenderError, type PdfRenderer } from './pdf.js';

// PDF生成そのものはtests/pdf.integration.test.tsで実Chromiumを使って検証する。
// ここではHTTP層(検証・エラー応答・配信)だけを確認するため、呼び出し内容を記録する代役を使う
class RecordingRenderer implements PdfRenderer {
  readonly htmls: string[] = [];
  failWith: Error | undefined;

  render(html: string): Promise<Buffer> {
    this.htmls.push(html);
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(Buffer.from('%PDF-1.7 dummy'));
  }

  chromiumVersion(): Promise<string> {
    return Promise.resolve('Chromium/test');
  }
}

const MAX_BYTES = 200;
const renderer = new RecordingRenderer();
let clientDir: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  clientDir = mkdtempSync(join(tmpdir(), 'md-pdf-editor-client-'));
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>t</title>');
  const app = createApp({ maxMarkdownBytes: MAX_BYTES, renderer, css: '.document{}', clientDir, chromiumVersion: 'Chromium/test' });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  rmSync(clientDir, { recursive: true, force: true });
});

const postPdf = (body: string, contentType = 'application/json'): Promise<Response> =>
  fetch(`${baseUrl}/api/pdf`, { method: 'POST', headers: { 'Content-Type': contentType }, body });

describe('GET /healthz', () => {
  it('okとChromiumの版を返す', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', chromium: 'Chromium/test' });
  });
});

describe('POST /api/pdf', () => {
  it('Markdownを渡すとPDFを返し、共有CSSを含むHTMLがレンダラへ渡る', async () => {
    renderer.htmls.length = 0;
    const res = await postPdf(JSON.stringify({ markdown: '# 見出し\n\n本文' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(renderer.htmls).toHaveLength(1);
    expect(renderer.htmls[0]).toContain('<h1>見出し</h1>');
    expect(renderer.htmls[0]).toContain('.document{}');
  });

  it.each([
    ['markdownが無い', JSON.stringify({}), 'invalid_request'],
    ['markdownが文字列でない', JSON.stringify({ markdown: 1 }), 'invalid_request'],
    ['markdownが空白だけ', JSON.stringify({ markdown: '  \n ' }), 'empty_markdown'],
  ])('%sなら400', async (_label, body, code) => {
    const res = await postPdf(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
  });

  it('JSONとして壊れていれば400', async () => {
    const res = await postPdf('{broken');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_json');
  });

  it('JSON以外のContent-Typeは、本文を解釈せず400', async () => {
    const res = await postPdf('# 見出し', 'text/plain');
    expect(res.status).toBe(400);
  });

  it('上限(バイト数)を超えると413。日本語は文字数ではなくバイト数で数える', async () => {
    const res = await postPdf(JSON.stringify({ markdown: 'あ'.repeat(MAX_BYTES / 3 + 1) }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('markdown_too_large');
  });

  it('パース上限そのものを超える巨大なリクエストも413', async () => {
    const res = await postPdf(JSON.stringify({ markdown: 'a'.repeat(MAX_BYTES * 3) }));
    expect(res.status).toBe(413);
  });

  it('PDF生成に失敗したら500でメッセージを返し、原因をログに残す(空のPDFを返さない)', async () => {
    renderer.failWith = new PdfRenderError('PDFの生成に失敗しました: テスト');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await postPdf(JSON.stringify({ markdown: '# a' }));
      expect(res.status).toBe(500);
      const error = ((await res.json()) as { error: { code: string; message: string } }).error;
      expect(error.code).toBe('pdf_failed');
      expect(error.message).toContain('テスト');
      expect(errorLog).toHaveBeenCalledWith(renderer.failWith);
    } finally {
      errorLog.mockRestore();
      renderer.failWith = undefined;
    }
  });

  it('想定外の例外は内部エラーとして500にし、詳細は応答に含めずログにだけ残す', async () => {
    renderer.failWith = new Error('秘密のパス /etc/shadow');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await postPdf(JSON.stringify({ markdown: '# a' }));
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toContain('internal_error');
      expect(text).not.toContain('/etc/shadow');
      expect(errorLog).toHaveBeenCalledWith(renderer.failWith);
    } finally {
      errorLog.mockRestore();
      renderer.failWith = undefined;
    }
  });
});

describe('配信', () => {
  it('/ でクライアントを配信し、セキュリティヘッダが付く', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("img-src 'self' data: blob:");
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('未定義の /api/* は404のJSON', async () => {
    const res = await fetch(`${baseUrl}/api/unknown`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });
});
