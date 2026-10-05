import { describe, expect, it } from 'vitest';
import { PdfRequestError, requestPdf, type FetchLike } from './pdfClient';

const pdfResponse = (): Response =>
  new Response('%PDF-1.7 dummy', { status: 200, headers: { 'Content-Type': 'application/pdf' } });

const jsonError = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: { code: 'x', message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('requestPdf', () => {
  it('MarkdownをJSONで /api/pdf へPOSTし、PDFのBlobを返す', async () => {
    let captured: { input: string; init: RequestInit } | undefined;
    const fetchFn: FetchLike = (input, init) => {
      captured = { input, init };
      return Promise.resolve(pdfResponse());
    };

    const blob = await requestPdf('# 見出し', fetchFn);

    expect(captured?.input).toBe('/api/pdf');
    expect(captured?.init.method).toBe('POST');
    expect(JSON.parse(String(captured?.init.body))).toEqual({ markdown: '# 見出し' });
    expect(await blob.text()).toBe('%PDF-1.7 dummy');
  });

  it('サーバが返したエラーメッセージをそのまま例外にする', async () => {
    const fetchFn: FetchLike = () => Promise.resolve(jsonError(413, 'Markdownが大きすぎます。'));
    await expect(requestPdf('x', fetchFn)).rejects.toThrowError('Markdownが大きすぎます。');
    await expect(requestPdf('x', fetchFn)).rejects.toBeInstanceOf(PdfRequestError);
  });

  it('JSONでないエラー応答は、HTTPステータスを示すメッセージにする', async () => {
    const fetchFn: FetchLike = () => Promise.resolve(new Response('<html>Bad Gateway</html>', { status: 502 }));
    await expect(requestPdf('x', fetchFn)).rejects.toThrowError('HTTP 502');
  });

  it('接続できない場合は、起動確認を促すメッセージにする', async () => {
    const fetchFn: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(requestPdf('x', fetchFn)).rejects.toThrowError('サーバに接続できませんでした');
  });

  it('成功応答でもPDFでなければ例外にする', async () => {
    const fetchFn: FetchLike = () =>
      Promise.resolve(new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await expect(requestPdf('x', fetchFn)).rejects.toThrowError('PDFではありません');
  });
});
